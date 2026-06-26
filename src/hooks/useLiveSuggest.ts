import { useEffect, useState, useCallback, useRef } from "react";
import { useWindowResize } from ".";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { useApp } from "@/contexts";
import { fetchSTT, fetchAIResponse } from "@/lib/functions";
import {
  DEFAULT_LIVE_SUGGEST_PROMPT,
  LIVE_SUGGEST_DEEPEN_INSTRUCTIONS,
  STORAGE_KEYS,
  buildLiveSuggestFormatInstructions,
  LIVE_SUGGEST_FAMILIES,
} from "@/config";
import {
  safeLocalStorage,
  shouldUsePluelyAPI,
  CONVERSATION_SAVE_DEBOUNCE_MS,
  lsLog,
  detectResponseError,
  preview,
} from "@/lib";
import {
  getAllSystemPrompts,
  saveLiveSession,
  getLiveSessionById,
} from "@/lib/database";
import type {
  SystemPrompt,
  LiveSession,
  LiveItem,
  LiveContextItem,
  SuggestionCard,
  SuggestionFamily,
} from "@/types";
import type { VadConfig } from "./useSystemAudio";

export type Speaker = "you" | "them";

export interface TranscriptLine {
  id: string;
  speaker: Speaker;
  text: string;
  timestamp: number;
}

interface SystemAudioDiagnostic {
  event: string;
  sample_rate: number;
  rms: number;
  peak: number;
  speech_chunks: number;
  silence_chunks: number;
  buffered_samples: number;
  message: string;
}

interface LiveSpeechDetectedPayload {
  speaker: Speaker;
  audio: string;
}

interface LiveAudioActivityPayload {
  speaker: Speaker;
  active: boolean;
}

// VAD config tuned for always-on, hands-free system audio capture.
const LIVE_SUGGEST_VAD_CONFIG: VadConfig = {
  enabled: true,
  hop_size: 1024,
  sensitivity_rms: 0.0035,
  peak_threshold: 0.012,
  silence_chunks: 45,
  min_speech_chunks: 7,
  pre_speech_chunks: 12,
  noise_gate_threshold: 0.001,
  max_recording_duration_secs: 180,
};

// Debounce before (re)generating suggestions after new transcript lines.
const SUGGESTION_DEBOUNCE_MS = 1200;
// Cap how much of the transcript is sent to the model to control token usage.
const MAX_TRANSCRIPT_LINES = 40;
// Merge consecutive lines from the same speaker within this window.
const MERGE_WINDOW_MS = 8000;
// Cap the characters of a single text/file context item to control tokens.
const MAX_CONTEXT_CHARS = 16000;
// File types accepted by the context uploader.
export const CONTEXT_FILE_ACCEPT =
  ".txt,.md,.markdown,.csv,.tsv,.json,.log,.yaml,.yml,.xml,.html,.htm,.rtf,.ini,.conf,.toml,text/*,image/*";

let lineCounter = 0;
const generateLineId = (speaker: Speaker): string =>
  `ls_${speaker}_${Date.now()}_${lineCounter++}`;

let cardCounter = 0;
const generateCardId = (): string =>
  `card_${Date.now()}_${cardCounter++}_${Math.random().toString(36).slice(2, 6)}`;

let contextCounter = 0;
const generateContextId = (): string =>
  `ctx_${Date.now()}_${contextCounter++}_${Math.random().toString(36).slice(2, 6)}`;

const generateSessionId = (): string =>
  `live_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Read a File as plain text (for text-based context files).
const readFileAsText = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve((reader.result as string) || "");
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsText(file);
  });

// Read a File as raw base64 (no data-URL prefix) for image context.
const readFileAsBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      resolve(((reader.result as string) || "").split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });

// Compose the textual context block injected into the system prompt. Returns
// "" when there is no text context so the prompt is unchanged.
const buildContextBlock = (context: LiveContextItem[]): string => {
  const textItems = context.filter(
    (c) => (c.kind === "text" || c.kind === "file") && c.text && c.text.trim()
  );
  if (textItems.length === 0) return "";
  const blocks = textItems
    .map((c) => `--- ${c.name} ---\n${c.text!.trim()}`)
    .join("\n\n");
  const imageNote = context.some((c) => c.kind === "image")
    ? " One or more reference images are also attached."
    : "";
  return `\n\nBACKGROUND CONTEXT (reference material the user attached for this conversation; use it to ground your suggestions, but never read it aloud or output it verbatim).${imageNote}\n${blocks}`;
};

const fmtLine = (l: TranscriptLine): string =>
  `${l.speaker === "you" ? "You" : "Them"}: ${l.text}`;

interface ParsedCard {
  family: SuggestionFamily;
  categoryId: string;
  categoryLabel: string;
  title: string;
  body: string;
}

interface ParseResult {
  /** True when a JSON array was successfully parsed (even if empty). */
  parsed: boolean;
  /** Valid cards extracted from the array. */
  cards: ParsedCard[];
  /** Number of array elements that were dropped as malformed. */
  dropped: number;
}

// Robustly extract the JSON array of suggestion cards from a model response,
// tolerating code fences or stray prose around the array. Distinguishes a
// genuine empty array ("nothing noteworthy") from an unparseable reply.
const parseSuggestionCards = (raw: string): ParseResult => {
  const empty: ParseResult = { parsed: false, cards: [], dropped: 0 };
  if (!raw || !raw.trim()) return empty;
  let text = raw.trim();
  // Strip ```json ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  // Narrow to the outermost array.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return empty;
  const slice = text.slice(start, end + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return empty;
  }
  if (!Array.isArray(parsed)) return empty;

  // We have a valid JSON array — an empty one is a legitimate "no cards".
  const cards: ParsedCard[] = [];
  let dropped = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      dropped++;
      continue;
    }
    const obj = item as Record<string, unknown>;
    const body = typeof obj.body === "string" ? obj.body.trim() : "";
    if (!body) {
      dropped++;
      continue;
    }
    const rawFamily = typeof obj.family === "string" ? obj.family.trim() : "";
    const family = (LIVE_SUGGEST_FAMILIES as string[]).includes(rawFamily)
      ? (rawFamily as SuggestionFamily)
      : "insight";
    const rawCategoryId =
      typeof obj.category_id === "string" ? obj.category_id.trim() : "";
    const categoryId = rawCategoryId
      .toLowerCase()
      .replace(/[^a-z0-9_\s-]/g, "")
      .replace(/[\s-]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48);
    const rawCategoryLabel =
      typeof obj.category_label === "string" ? obj.category_label.trim() : "";
    const categoryLabel = rawCategoryLabel || "Suggestion";
    const title = typeof obj.title === "string" ? obj.title.trim() : "";
    cards.push({
      family,
      categoryId: categoryId || "suggestion",
      categoryLabel,
      title,
      body,
    });
  }
  return { parsed: true, cards, dropped };
};

// Build a persistable session from the in-memory transcript + suggestion cards.
// Each card is stored as a `suggestion` item carrying its visual family, dynamic
// category label, title and body, with anchor + elaboration metadata so the
// timeline can be rebuilt and interleaved exactly when viewed later.
const buildSession = (
  id: string,
  createdAt: number,
  transcript: TranscriptLine[],
  cards: SuggestionCard[],
  context: LiveContextItem[]
): LiveSession => {
  const items: LiveItem[] = transcript.map((line) => ({
    id: line.id,
    kind: "transcript",
    speaker: line.speaker,
    content: line.text,
    timestamp: line.timestamp,
  }));

  for (const card of cards) {
    items.push({
      id: card.id,
      kind: "suggestion",
      category: card.family,
      title: card.title,
      content: card.body,
      timestamp: card.timestamp,
      metadata: {
        categoryId: card.categoryId,
        categoryLabel: card.categoryLabel,
        anchorLineId: card.anchorLineId,
        ...(card.deeper ? { deeper: card.deeper } : {}),
      },
    });
  }

  const firstLine = transcript.find((l) => l.text.trim());
  const title = firstLine
    ? firstLine.text.trim().slice(0, 80)
    : "Live Suggest session";

  return {
    id,
    title,
    createdAt,
    updatedAt: Date.now(),
    items,
    context,
  };
};

// Reverse of `buildSession`: rebuild the in-memory transcript + suggestion
// cards from a persisted session so a stopped session can be resumed and
// continued (rather than only viewed).
const sessionToState = (
  session: LiveSession
): {
  transcript: TranscriptLine[];
  cards: SuggestionCard[];
  context: LiveContextItem[];
} => {
  const transcript: TranscriptLine[] = [];
  const cards: SuggestionCard[] = [];

  for (const item of session.items) {
    if (item.kind === "transcript") {
      transcript.push({
        id: item.id,
        speaker: (item.speaker as Speaker) || "them",
        text: item.content,
        timestamp: item.timestamp,
      });
    } else if (item.kind === "suggestion") {
      const meta = item.metadata || {};
      const anchorLineId =
        typeof meta.anchorLineId === "string" ? meta.anchorLineId : null;
      const family = (LIVE_SUGGEST_FAMILIES as string[]).includes(
        item.category || ""
      )
        ? (item.category as SuggestionFamily)
        : "insight";
      const categoryId =
        typeof meta.categoryId === "string" ? meta.categoryId : "suggestion";
      const categoryLabel =
        typeof meta.categoryLabel === "string" ? meta.categoryLabel : "Suggestion";
      const deeper =
        typeof meta.deeper === "string" ? (meta.deeper as string) : undefined;
      cards.push({
        id: item.id,
        family,
        categoryId,
        categoryLabel,
        title: item.title || "",
        body: item.content,
        anchorLineId,
        timestamp: item.timestamp,
        ...(deeper ? { deeper } : {}),
      });
    }
  }

  transcript.sort((a, b) => a.timestamp - b.timestamp);
  cards.sort((a, b) => a.timestamp - b.timestamp);
  const context = Array.isArray(session.context) ? session.context : [];
  return { transcript, cards, context };
};

export type useLiveSuggestType = ReturnType<typeof useLiveSuggest>;

export function useLiveSuggest() {
  const { resizeWindow } = useWindowResize();

  const {
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
    selectedAudioDevices,
    supportsImages,
  } = useApp();

  const [active, setActive] = useState(false);
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  // Explicit panel height in px (derived from the window height we set), so the
  // panel doesn't depend on `100vh`, which is unreliable in the transparent
  // overlay webview.
  const [panelHeight, setPanelHeight] = useState<number>(0);
  const [transcript, setTranscript] = useState<TranscriptLine[]>([]);
  const [cards, setCards] = useState<SuggestionCard[]>([]);
  // Per-session background context (typed notes, text files, images) injected
  // into suggestion generation.
  const [context, setContext] = useState<LiveContextItem[]>([]);
  // Id of the card currently being elaborated via "Go deeper" (for spinners).
  const [deepeningId, setDeepeningId] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [suggestionsPaused, setSuggestionsPaused] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [systemAudioActive, setSystemAudioActive] = useState(false);
  const [micAudioActive, setMicAudioActive] = useState(false);
  const [error, setError] = useState<string>("");
  const [setupRequired, setSetupRequired] = useState(false);

  // The library prompt marked as the Live Suggest default is resolved at
  // generation time (null = use the built-in prompt). It can be changed from
  // the System Prompts page or live from the overlay prompt switch.
  const [liveSuggestPromptId, setLiveSuggestPromptIdState] = useState<
    number | null
  >(() => {
      const stored = safeLocalStorage.getItem(
        STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID
      );
      return stored ? Number(stored) : null;
    });
  const liveSuggestPromptIdRef = useRef<number | null>(liveSuggestPromptId);
  const promptsRef = useRef<SystemPrompt[]>([]);

  // Add a free-text note as background context for the current session.
  const addContextText = useCallback((text: string) => {
    const clean = text.trim();
    if (!clean) return;
    const item: LiveContextItem = {
      id: generateContextId(),
      kind: "text",
      name: "Note",
      text: clean.slice(0, MAX_CONTEXT_CHARS),
      timestamp: Date.now(),
    };
    setContext((prev) => [...prev, item]);
    lsLog.info("Context added (text)", { chars: item.text?.length ?? 0 });
  }, []);

  // Add one or more files as background context. Images (when the active model
  // supports vision) are stored as base64 and passed to the model; everything
  // else is read as plain text and injected into the prompt.
  const addContextFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) return;

      for (const file of list) {
        try {
          const isImage = file.type.startsWith("image/");
          if (isImage) {
            if (!supportsImagesRef.current) {
              lsLog.warn(
                "Context image skipped: selected model does not support images.",
                { name: file.name }
              );
              setError(
                "The selected model doesn't support images. Choose a vision model or attach text instead."
              );
              continue;
            }
            const imageBase64 = await readFileAsBase64(file);
            if (!imageBase64) continue;
            const item: LiveContextItem = {
              id: generateContextId(),
              kind: "image",
              name: file.name || "image",
              imageBase64,
              mimeType: file.type || "image/png",
              timestamp: Date.now(),
            };
            setContext((prev) => [...prev, item]);
            lsLog.info("Context added (image)", {
              name: item.name,
              bytes: file.size,
            });
          } else {
            const raw = await readFileAsText(file);
            const text = raw.trim();
            if (!text) {
              lsLog.warn("Context file skipped: empty or unreadable text.", {
                name: file.name,
              });
              continue;
            }
            const item: LiveContextItem = {
              id: generateContextId(),
              kind: "file",
              name: file.name || "file",
              text: text.slice(0, MAX_CONTEXT_CHARS),
              timestamp: Date.now(),
            };
            setContext((prev) => [...prev, item]);
            lsLog.info("Context added (file)", {
              name: item.name,
              chars: item.text?.length ?? 0,
              truncated: text.length > MAX_CONTEXT_CHARS,
            });
          }
          setError("");
        } catch (err: any) {
          lsLog.error("Failed to read context file:", err?.message || err);
          setError(`Failed to read "${file.name}".`);
        }
      }
    },
    []
  );

  const removeContext = useCallback((id: string) => {
    setContext((prev) => prev.filter((c) => c.id !== id));
  }, []);

  const clearContext = useCallback(() => {
    setContext([]);
  }, []);

  // Refs keep the speech-detected listener and async callbacks stable while
  // still reading the latest values.
  const activeRef = useRef(false);
  const suggestionsPausedRef = useRef(false);
  const sttProviderRef = useRef(selectedSttProvider);
  const sttListRef = useRef(allSttProviders);
  const aiProviderRef = useRef(selectedAIProvider);
  const aiListRef = useRef(allAiProviders);
  const transcriptRef = useRef<TranscriptLine[]>([]);
  const cardsRef = useRef<SuggestionCard[]>([]);
  const contextRef = useRef<LiveContextItem[]>([]);
  const supportsImagesRef = useRef<boolean>(supportsImages);
  const transcriptMergeBoundaryRef = useRef<number>(0);
  // Transcript timestamp up to which suggestions have already been generated,
  // so each generation only reacts to genuinely new lines.
  const lastProcessedTsRef = useRef<number>(0);
  const outputDeviceIdRef = useRef<string | null>(null);
  const inputDeviceNameRef = useRef<string | null>(null);
  const deepenAbortRef = useRef<AbortController | null>(null);

  // Persistence: current session identity + debounced save bookkeeping.
  const sessionIdRef = useRef<string>(generateSessionId());
  const sessionCreatedAtRef = useRef<number>(Date.now());
  const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isSavingRef = useRef<boolean>(false);

  const abortControllerRef = useRef<AbortController | null>(null);
  const generationTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Keep refs in sync with the latest values.
  useEffect(() => {
    activeRef.current = active;
  }, [active]);
  useEffect(() => {
    suggestionsPausedRef.current = suggestionsPaused;
  }, [suggestionsPaused]);
  useEffect(() => {
    sttProviderRef.current = selectedSttProvider;
    sttListRef.current = allSttProviders;
    aiProviderRef.current = selectedAIProvider;
    aiListRef.current = allAiProviders;
  }, [
    selectedSttProvider,
    allSttProviders,
    selectedAIProvider,
    allAiProviders,
  ]);
  useEffect(() => {
    transcriptRef.current = transcript;
  }, [transcript]);
  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);
  useEffect(() => {
    contextRef.current = context;
  }, [context]);
  useEffect(() => {
    supportsImagesRef.current = supportsImages;
  }, [supportsImages]);
  useEffect(() => {
    outputDeviceIdRef.current =
      selectedAudioDevices.output.id &&
      selectedAudioDevices.output.id !== "default"
        ? selectedAudioDevices.output.id
        : null;
  }, [selectedAudioDevices.output.id]);
  useEffect(() => {
    inputDeviceNameRef.current = selectedAudioDevices.input.name || null;
  }, [selectedAudioDevices.input.name]);

  // Load library system prompts so the marked Live Suggest default can be
  // resolved (re-loaded when a session starts so edits made elsewhere apply).
  const loadPrompts = useCallback(async () => {
    try {
      promptsRef.current = await getAllSystemPrompts();
    } catch (err) {
      lsLog.error("Failed to load system prompts for Live Suggest:", err);
    }
  }, []);

  useEffect(() => {
    loadPrompts();
  }, [loadPrompts]);

  useEffect(() => {
    if (active) loadPrompts();
  }, [active, loadPrompts]);

  const setLiveSuggestPrompt = useCallback(
    (id: number | null) => {
      setLiveSuggestPromptIdState(id);
      liveSuggestPromptIdRef.current = id;
      if (id == null) {
        safeLocalStorage.removeItem(STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID);
      } else {
        safeLocalStorage.setItem(STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID, String(id));
      }
      void loadPrompts();
      lsLog.info("Live Suggest prompt changed", { promptId: id ?? "built-in" });
    },
    [loadPrompts]
  );

  // Keep the resolved default prompt id in sync with the System Prompts page,
  // which lives in the dashboard window and writes the same localStorage key.
  useEffect(() => {
    const handleStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEYS.LIVE_SUGGEST_PROMPT_ID) {
        const next = e.newValue ? Number(e.newValue) : null;
        liveSuggestPromptIdRef.current = next;
        setLiveSuggestPromptIdState(next);
        void loadPrompts();
      }
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [loadPrompts]);

  // Append a transcript line. Consecutive lines from the same speaker within a
  // short window are merged so the conversation reads naturally.
  const appendLine = useCallback((speaker: Speaker, text: string) => {
    const clean = text.trim();
    if (!clean) return;

    setTranscript((prev) => {
      const last = prev[prev.length - 1];
      if (
        last &&
        last.speaker === speaker &&
        last.timestamp > transcriptMergeBoundaryRef.current &&
        Date.now() - last.timestamp < MERGE_WINDOW_MS
      ) {
        const merged = [...prev];
        merged[merged.length - 1] = {
          ...last,
          text: `${last.text} ${clean}`.trim(),
          timestamp: Date.now(),
        };
        return merged;
      }
      const line: TranscriptLine = {
        id: generateLineId(speaker),
        speaker,
        text: clean,
        timestamp: Date.now(),
      };
      return [...prev, line];
    });
  }, []);

  // Transcribe an audio blob and append the resulting text to the transcript.
  const transcribeAndAppend = useCallback(
    async (speaker: Speaker, audioBlob: Blob) => {
      const started = performance.now();
      try {
        const usePluelyAPI = await shouldUsePluelyAPI();
        const provider = sttProviderRef.current;
        const list = sttListRef.current;

        if (!provider.provider && !usePluelyAPI) {
          lsLog.warn("STT skipped: no speech-to-text provider selected.");
          setError("No speech-to-text provider selected.");
          return;
        }

        const providerConfig = list.find((p) => p.id === provider.provider);
        if (!providerConfig && !usePluelyAPI) {
          lsLog.warn(
            `STT skipped: provider config not found for "${provider.provider}".`
          );
          setError("Speech provider configuration not found.");
          return;
        }

        lsLog.debug("STT request", {
          speaker,
          audioBytes: audioBlob.size,
          provider: usePluelyAPI ? "pluely-api" : providerConfig?.id,
        });

        setIsTranscribing(true);

        const sttPromise = fetchSTT({
          provider: usePluelyAPI ? undefined : providerConfig,
          selectedProvider: provider,
          audio: audioBlob,
        });

        const timeoutPromise = new Promise<string>((_, reject) => {
          setTimeout(
            () => reject(new Error("Transcription timed out (30s)")),
            30000
          );
        });

        const transcription = await Promise.race([sttPromise, timeoutPromise]);
        const elapsed = Math.round(performance.now() - started);

        // fetchSTT returns some failures as plain strings instead of throwing.
        const sttError = detectResponseError(transcription);
        if (sttError) {
          lsLog.error(
            `STT failed (${speaker}, ${elapsed}ms): ${sttError}`,
            { provider: usePluelyAPI ? "pluely-api" : providerConfig?.id }
          );
          setError(`Transcription failed: ${sttError}`);
          return;
        }

        const clean = transcription?.trim() ?? "";
        // Markers that mean "nothing was said" — log quietly, never append.
        if (!clean || /^no transcription found$/i.test(clean)) {
          lsLog.debug(
            `STT empty (${speaker}, ${elapsed}ms): no usable transcription.`
          );
          return;
        }

        lsLog.info(
          `STT ok (${speaker}, ${elapsed}ms, ${clean.length} chars): "${preview(
            clean,
            120
          )}"`
        );
        setError("");
        appendLine(speaker, clean);
      } catch (err: any) {
        const elapsed = Math.round(performance.now() - started);
        lsLog.error(
          `STT exception (${speaker}, ${elapsed}ms):`,
          err?.message || err
        );
        setError(err?.message || "Failed to transcribe audio");
      } finally {
        setIsTranscribing(false);
      }
    },
    [appendLine]
  );

  // Generate inline suggestion cards reacting to the newest transcript lines.
  // Prior lines are sent as context only; cards are appended (and anchored to
  // the latest line) so they interleave with the transcript chronologically.
  const generateSuggestions = useCallback(async () => {
    if (suggestionsPausedRef.current) {
      lsLog.debug("Generation skipped: suggestions are paused.");
      return;
    }

    const lines = transcriptRef.current;
    if (lines.length === 0) return;

    const lastTs = lines[lines.length - 1].timestamp;
    const newLines = lines.filter(
      (l) => l.timestamp > lastProcessedTsRef.current
    );
    if (newLines.length === 0) {
      lsLog.debug("Generation skipped: no new transcript lines.");
      return;
    }

    // Abort any in-flight generation.
    if (abortControllerRef.current) {
      lsLog.debug("Aborting in-flight generation to start a new one.");
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const started = performance.now();
    try {
      const usePluelyAPI = await shouldUsePluelyAPI();
      const aiProvider = aiProviderRef.current;
      const aiList = aiListRef.current;

      if (!aiProvider.provider && !usePluelyAPI) {
        lsLog.warn("Generation skipped: no AI provider selected.");
        setError("No AI provider selected.");
        return;
      }

      const provider = aiList.find((p) => p.id === aiProvider.provider);
      if (!provider && !usePluelyAPI) {
        lsLog.warn(
          `Generation skipped: AI provider config not found for "${aiProvider.provider}".`
        );
        setError("AI provider configuration not found.");
        return;
      }

      const recent = lines.slice(-MAX_TRANSCRIPT_LINES);
      const newIds = new Set(newLines.map((l) => l.id));
      const contextText = recent
        .filter((l) => !newIds.has(l.id))
        .map(fmtLine)
        .join("\n");
      const newText = newLines.map(fmtLine).join("\n");

      // A library prompt marked for Live Suggest controls the persona. The
      // built-in fallback is used only when none is selected. The strict JSON
      // output contract is appended so the reply parses into dynamic cards.
      const selectedId = liveSuggestPromptIdRef.current;
      const selectedPrompt =
        selectedId != null
          ? promptsRef.current.find((p) => p.id === selectedId)?.prompt
          : undefined;
      const persona = selectedPrompt || DEFAULT_LIVE_SUGGEST_PROMPT;
      // Inject any user-provided background context (notes/files) into the
      // system prompt; collect attached images for vision-capable providers.
      const ctx = contextRef.current;
      const contextBlock = buildContextBlock(ctx);
      const providerSupportsImages =
        supportsImagesRef.current &&
        (usePluelyAPI || !!provider?.curl?.includes("{{IMAGE}}"));
      const imagesBase64 = providerSupportsImages
        ? ctx
            .filter((c) => c.kind === "image" && c.imageBase64)
            .map((c) => c.imageBase64 as string)
        : [];
      const systemPrompt = `${persona}${contextBlock}\n\n${buildLiveSuggestFormatInstructions()}`;

      const userMessage = `${
        contextText
          ? `Earlier conversation (context only, do not respond to these):\n${contextText}\n\n`
          : ""
      }NEW lines to react to:\n${newText}`;

      lsLog.info("Generation start", {
        personaSource: selectedPrompt ? `library-prompt#${selectedId}` : "built-in",
        provider: usePluelyAPI ? "pluely-api" : provider?.id,
        streaming: usePluelyAPI ? true : !!provider?.streaming,
        newLines: newLines.length,
        totalLines: lines.length,
        systemPromptChars: systemPrompt.length,
        userMessageChars: userMessage.length,
        contextItems: ctx.length,
        contextImages: imagesBase64.length,
      });
      lsLog.debug("Generation NEW lines:\n" + newText);

      setIsGenerating(true);

      let full = "";
      let chunks = 0;
      for await (const chunk of fetchAIResponse({
        provider: usePluelyAPI ? undefined : provider,
        selectedProvider: aiProvider,
        systemPrompt,
        history: [],
        userMessage,
        imagesBase64,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        full += chunk;
        chunks++;
      }
      if (controller.signal.aborted) {
        lsLog.debug("Generation aborted before completion.");
        return;
      }

      const elapsed = Math.round(performance.now() - started);

      // fetchAIResponse yields API errors as content rather than throwing.
      // Surface them instead of silently producing no cards.
      const apiError = detectResponseError(full);
      if (apiError) {
        lsLog.error(`Generation API error (${elapsed}ms): ${apiError}`, {
          provider: usePluelyAPI ? "pluely-api" : provider?.id,
        });
        setError(`Suggestion generation failed: ${apiError}`);
        // Do not advance the watermark, so it can retry once the issue is fixed.
        return;
      }

      const { parsed, cards: parsedCards, dropped } = parseSuggestionCards(full);
      // Only advance the watermark once a valid (non-error) response is in.
      lastProcessedTsRef.current = lastTs;

      if (!parsed) {
        // No JSON array could be extracted from the reply. This is a real
        // format problem (or an empty/blank response), not the model choosing
        // to stay silent — log the raw reply so it's debuggable.
        lsLog.warn(
          `Generation reply was not a JSON array (${elapsed}ms, ${chunks} chunks). Raw reply: ${
            full.trim() ? preview(full) : "<empty response>"
          }`
        );
        setError("");
        return;
      }

      if (parsedCards.length === 0) {
        // The model explicitly returned [] — nothing noteworthy to suggest.
        lsLog.info(
          `Generation: model returned an empty array (${elapsed}ms) — nothing noteworthy${
            dropped ? `; ${dropped} malformed item(s) dropped` : ""
          }.`
        );
        setError("");
        return;
      }

      if (dropped) {
        lsLog.warn(
          `Generation: ${dropped} malformed card(s) dropped from the reply.`
        );
      }

      const anchorId = newLines[newLines.length - 1].id;
      const newCards: SuggestionCard[] = parsedCards.map((c, i) => ({
        id: generateCardId(),
        family: c.family,
        categoryId: c.categoryId,
        categoryLabel: c.categoryLabel,
        title: c.title,
        body: c.body,
        anchorLineId: anchorId,
        // Place just after the anchored line so it interleaves correctly.
        timestamp: lastTs + i + 1,
      }));
      lsLog.info(
        `Generation ok (${elapsed}ms, ${chunks} chunks): ${
          newCards.length
        } card(s) [${newCards.map((c) => c.categoryLabel).join(", ")}]`
      );
      setError("");
      setCards((prev) => [...prev, ...newCards]);
    } catch (err: any) {
      if (!controller.signal.aborted) {
        const elapsed = Math.round(performance.now() - started);
        lsLog.error(
          `Generation exception (${elapsed}ms):`,
          err?.message || err
        );
        setError(err?.message || "Failed to generate suggestions");
      }
    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
      setIsGenerating(false);
    }
  }, []);

  // Expand a single suggestion card into a deeper explanation ("Go deeper").
  const goDeeper = useCallback(async (cardId: string) => {
    const card = cardsRef.current.find((c) => c.id === cardId);
    if (!card) {
      lsLog.warn(`Go deeper ignored: card "${cardId}" not found.`);
      return;
    }

    if (deepenAbortRef.current) deepenAbortRef.current.abort();
    const controller = new AbortController();
    deepenAbortRef.current = controller;

    const started = performance.now();
    try {
      const usePluelyAPI = await shouldUsePluelyAPI();
      const aiProvider = aiProviderRef.current;
      const provider = aiListRef.current.find(
        (p) => p.id === aiProvider.provider
      );
      if (!aiProvider.provider && !usePluelyAPI) {
        lsLog.warn("Go deeper skipped: no AI provider selected.");
        setError("No AI provider selected.");
        return;
      }
      if (!provider && !usePluelyAPI) {
        lsLog.warn("Go deeper skipped: AI provider config not found.");
        setError("AI provider configuration not found.");
        return;
      }

      lsLog.info(`Go deeper start: ${card.categoryLabel} "${card.title}"`, {
        provider: usePluelyAPI ? "pluely-api" : provider?.id,
      });

      setDeepeningId(cardId);
      // Reset any prior elaboration so the new one streams in cleanly.
      setCards((prev) =>
        prev.map((c) => (c.id === cardId ? { ...c, deeper: "" } : c))
      );

      const recent = transcriptRef.current
        .slice(-MAX_TRANSCRIPT_LINES)
        .map(fmtLine)
        .join("\n");
      const ctx = contextRef.current;
      const contextBlock = buildContextBlock(ctx);
      const providerSupportsImages =
        supportsImagesRef.current &&
        (usePluelyAPI || !!provider?.curl?.includes("{{IMAGE}}"));
      const imagesBase64 = providerSupportsImages
        ? ctx
            .filter((c) => c.kind === "image" && c.imageBase64)
            .map((c) => c.imageBase64 as string)
        : [];
      const userMessage = `Suggestion family: ${card.family}\nSuggestion category: ${card.categoryLabel}\nTitle: ${card.title}\nBody: ${card.body}\n\nConversation context:\n${recent}${contextBlock}`;

      let full = "";
      for await (const chunk of fetchAIResponse({
        provider: usePluelyAPI ? undefined : provider,
        selectedProvider: aiProvider,
        systemPrompt: LIVE_SUGGEST_DEEPEN_INSTRUCTIONS,
        history: [],
        userMessage,
        imagesBase64,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) return;
        full += chunk;
        setCards((prev) =>
          prev.map((c) => (c.id === cardId ? { ...c, deeper: full } : c))
        );
      }
      if (controller.signal.aborted) return;

      const elapsed = Math.round(performance.now() - started);
      const apiError = detectResponseError(full);
      if (apiError) {
        lsLog.error(`Go deeper API error (${elapsed}ms): ${apiError}`);
        setError(`Go deeper failed: ${apiError}`);
        // Drop the error text from the card so it isn't shown as content.
        setCards((prev) =>
          prev.map((c) => (c.id === cardId ? { ...c, deeper: "" } : c))
        );
        return;
      }
      lsLog.info(`Go deeper ok (${elapsed}ms, ${full.length} chars).`);
      setError("");
    } catch (err: any) {
      if (!controller.signal.aborted) {
        const elapsed = Math.round(performance.now() - started);
        lsLog.error(`Go deeper exception (${elapsed}ms):`, err?.message || err);
        setError(err?.message || "Failed to expand suggestion");
      }
    } finally {
      if (deepenAbortRef.current === controller) {
        deepenAbortRef.current = null;
      }
      setDeepeningId(null);
    }
  }, []);

  // Debounced auto-generation whenever the transcript grows.
  useEffect(() => {
    if (!active || suggestionsPaused || transcript.length === 0) return;

    if (generationTimerRef.current) {
      clearTimeout(generationTimerRef.current);
    }
    generationTimerRef.current = setTimeout(() => {
      generateSuggestions();
    }, SUGGESTION_DEBOUNCE_MS);

    return () => {
      if (generationTimerRef.current) {
        clearTimeout(generationTimerRef.current);
      }
    };
  }, [transcript, active, suggestionsPaused, generateSuggestions]);

  // While paused, keep transcription flowing but mark those transcript lines as
  // handled so resuming suggestions only reacts to new speech after resume.
  useEffect(() => {
    if (!active || !suggestionsPaused || transcript.length === 0) return;
    lastProcessedTsRef.current = transcript[transcript.length - 1].timestamp;
  }, [active, suggestionsPaused, transcript]);

  // Listen for native live-capture speech segments from mic and system audio.
  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    const trackUnlisten = (unlisten: () => void) => {
      if (cancelled) {
        unlisten();
      } else {
        unlisteners.push(unlisten);
      }
    };

    const setup = async () => {
      try {
        trackUnlisten(
          await listen("live-capture-started", (event) => {
            if (!activeRef.current) return;
            lsLog.info(`Live native audio capture started (${event.payload}Hz).`);
          })
        );
        trackUnlisten(
          await listen("live-capture-stopped", () => {
            if (!activeRef.current) return;
            lsLog.info("Live native audio capture stopped.");
          })
        );
        trackUnlisten(
          await listen<string>("live-speech-start", (event) => {
            if (!activeRef.current) return;
            lsLog.info(`Live ${String(event.payload)} VAD speech start.`);
          })
        );
        trackUnlisten(
          await listen("speech-discarded", (event) => {
            if (!activeRef.current) return;
            lsLog.warn(`System-audio speech discarded: ${String(event.payload)}`);
          })
        );
        trackUnlisten(
          await listen("audio-encoding-error", (event) => {
            if (!activeRef.current) return;
            lsLog.error(`System-audio encoding error: ${String(event.payload)}`);
          })
        );
        trackUnlisten(
          await listen<SystemAudioDiagnostic>("system-audio-diagnostic", (event) => {
            if (!activeRef.current) return;
            const d = event.payload;
            const line = `System-audio diag ${d.event}: sr=${d.sample_rate}, rms=${d.rms.toFixed(
              5
            )}, peak=${d.peak.toFixed(5)}, speech_chunks=${d.speech_chunks}, silence_chunks=${d.silence_chunks}, buffered=${d.buffered_samples}. ${d.message}`;
            if (d.event === "levels") {
              lsLog.debug(line);
            } else if (d.event === "speech-discarded") {
              lsLog.warn(line);
            } else if (d.event === "audio-encoding-error") {
              lsLog.error(line);
            } else {
              lsLog.info(line);
            }
          })
        );
        trackUnlisten(
          await listen<LiveSpeechDetectedPayload>(
            "live-speech-detected",
            async (event) => {
              if (!activeRef.current) return;
              try {
                const { speaker, audio: base64Audio } = event.payload;
                if (speaker !== "you" && speaker !== "them") return;
                const binaryString = atob(base64Audio);
                const bytes = new Uint8Array(binaryString.length);
                for (let i = 0; i < binaryString.length; i++) {
                  bytes[i] = binaryString.charCodeAt(i);
                }
                const audioBlob = new Blob([bytes], { type: "audio/wav" });
                lsLog.debug(
                  `Live ${speaker} speech segment received (${audioBlob.size} bytes).`
                );
                await transcribeAndAppend(speaker, audioBlob);
              } catch (err) {
                lsLog.error("Failed to process live audio speech:", err);
              }
            }
          )
        );
        trackUnlisten(
          await listen<LiveAudioActivityPayload>("live-audio-activity", (event) => {
            const active = Boolean(event.payload?.active) && activeRef.current;
            if (event.payload?.speaker === "you") {
              setMicAudioActive(active);
            } else if (event.payload?.speaker === "them") {
              setSystemAudioActive(active);
            }
          })
        );
        if (!cancelled) {
          lsLog.debug("Live native speech listeners attached.");
        }
      } catch (err) {
        if (!cancelled) {
          lsLog.error("Failed to set up Live Suggest speech listener:", err);
        }
      }
    };

    setup();
    return () => {
      cancelled = true;
      for (const unlisten of unlisteners.splice(0)) {
        unlisten();
      }
    };
  }, [transcribeAndAppend]);

  // Shared capture bring-up used by both `start` (fresh session) and `resume`
  // (existing session). Assumes session identity + in-memory state are already
  // set by the caller.
  const beginCapture = useCallback(async () => {
    try {
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (!hasAccess) {
        lsLog.warn("System audio access not granted — showing setup flow.");
        setSetupRequired(true);
        return;
      }

      // Ensure no other capture is running, then start native mic + system audio capture.
      await invoke<string>("stop_live_audio_capture").catch(() => {});
      await invoke<string>("stop_system_audio_capture").catch(() => {});

      await invoke<string>("start_live_audio_capture", {
        vadConfig: LIVE_SUGGEST_VAD_CONFIG,
        outputDeviceId: outputDeviceIdRef.current,
        inputDeviceName: inputDeviceNameRef.current,
      });
      lsLog.info("Native Live Suggest audio capture started.");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      lsLog.error("Failed to start system audio capture:", msg);
      setError(msg);
      setIsPanelOpen(true);
    }
  }, []);

  const start = useCallback(async () => {
    // Turn the session on SYNCHRONOUSLY (within the click gesture) so the
    // microphone VAD component mounts immediately and getUserMedia keeps the
    // user-activation needed to open the mic + AudioContext.
    setError("");
    setSetupRequired(false);
    setTranscript([]);
    setCards([]);
    setContext([]);
    setDeepeningId(null);
    suggestionsPausedRef.current = false;
    setSuggestionsPaused(false);
    transcriptMergeBoundaryRef.current = 0;
    setSystemAudioActive(false);
    setMicAudioActive(false);
    lastProcessedTsRef.current = 0;
    // Start a fresh persisted session.
    sessionIdRef.current = generateSessionId();
    sessionCreatedAtRef.current = Date.now();
    setActive(true);
    setIsPanelOpen(true);
    lsLog.info("Session start", {
      sessionId: sessionIdRef.current,
      outputDeviceId: outputDeviceIdRef.current ?? "default",
    });

    await beginCapture();
  }, [beginCapture]);

  // Resume a previously stopped session: rehydrate its transcript + suggestion
  // cards, adopt its persisted id/createdAt (so further saves append to the
  // same record), then restart capture. New speech continues the session;
  // suggestions are only generated for genuinely new lines (watermark below).
  const resume = useCallback(
    async (sessionId: string) => {
      if (!sessionId) return;
      lsLog.info("Session resume requested", { sessionId });

      // Auto-switch: stop any in-flight generation/capture from a current
      // session before loading the selected one.
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (deepenAbortRef.current) {
        deepenAbortRef.current.abort();
        deepenAbortRef.current = null;
      }
      if (generationTimerRef.current) {
        clearTimeout(generationTimerRef.current);
        generationTimerRef.current = null;
      }

      let session: LiveSession | null = null;
      try {
        session = await getLiveSessionById(sessionId);
      } catch (err) {
        lsLog.error("Failed to load session for resume:", err);
      }
      if (!session) {
        setError("Could not load that session to resume.");
        setIsPanelOpen(true);
        return;
      }

      const {
        transcript: restoredTranscript,
        cards: restoredCards,
        context: restoredContext,
      } = sessionToState(session);

      // Adopt the existing session identity so saves update this record.
      sessionIdRef.current = session.id;
      sessionCreatedAtRef.current = session.createdAt;

      // Watermark suggestions to the latest restored line so resuming does not
      // regenerate cards for the whole backlog — only new speech triggers them.
      const lastTs = restoredTranscript.length
        ? restoredTranscript[restoredTranscript.length - 1].timestamp
        : 0;
      lastProcessedTsRef.current = lastTs;

      setError("");
      setSetupRequired(false);
      setDeepeningId(null);
      suggestionsPausedRef.current = false;
      setSuggestionsPaused(false);
      transcriptMergeBoundaryRef.current = Date.now();
      setTranscript(restoredTranscript);
      setCards(restoredCards);
      setContext(restoredContext);
      setSystemAudioActive(false);
      setMicAudioActive(false);
      setActive(true);
      setIsPanelOpen(true);
      lsLog.info("Session resumed", {
        sessionId: session.id,
        lines: restoredTranscript.length,
        cards: restoredCards.length,
        context: restoredContext.length,
      });

      await beginCapture();
    },
    [beginCapture]
  );

  // Resume is triggered from the dashboard window's history (a separate
  // webview), so listen for the cross-window event and rehydrate here where the
  // capture actually runs.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    listen<{ sessionId: string }>("live-suggest:resume", (event) => {
      const sessionId = event.payload?.sessionId;
      if (sessionId) resume(sessionId);
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch((err) => lsLog.error("Failed to attach resume listener:", err));
    return () => {
      if (unlisten) unlisten();
    };
  }, [resume]);

  const pauseSuggestions = useCallback(() => {
    suggestionsPausedRef.current = true;
    transcriptMergeBoundaryRef.current = Date.now();
    setSuggestionsPaused(true);

    if (generationTimerRef.current) {
      clearTimeout(generationTimerRef.current);
      generationTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }

    const latest = transcriptRef.current[transcriptRef.current.length - 1];
    if (latest) lastProcessedTsRef.current = latest.timestamp;
    setIsGenerating(false);
    lsLog.info("Suggestions paused", { sessionId: sessionIdRef.current });
  }, []);

  const resumeSuggestions = useCallback(() => {
    suggestionsPausedRef.current = false;
    transcriptMergeBoundaryRef.current = Date.now();
    setSuggestionsPaused(false);
    lsLog.info("Suggestions resumed", { sessionId: sessionIdRef.current });
  }, []);

  const toggleSuggestionsPaused = useCallback(() => {
    if (suggestionsPausedRef.current) {
      resumeSuggestions();
    } else {
      pauseSuggestions();
    }
  }, [pauseSuggestions, resumeSuggestions]);

  const stop = useCallback(async () => {
    lsLog.info("Session stop", { sessionId: sessionIdRef.current });
    try {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
        abortControllerRef.current = null;
      }
      if (generationTimerRef.current) {
        clearTimeout(generationTimerRef.current);
        generationTimerRef.current = null;
      }
      await invoke<string>("stop_live_audio_capture").catch(() => {});
    } finally {
      setActive(false);
      suggestionsPausedRef.current = false;
      setSuggestionsPaused(false);
      setIsTranscribing(false);
      setIsGenerating(false);
      setSystemAudioActive(false);
      setMicAudioActive(false);
      setIsPanelOpen(false);
    }
  }, []);

  const reset = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    if (deepenAbortRef.current) {
      deepenAbortRef.current.abort();
      deepenAbortRef.current = null;
    }
    // Begin a new persisted session so the prior one stays in history.
    sessionIdRef.current = generateSessionId();
    sessionCreatedAtRef.current = Date.now();
    setTranscript([]);
    setCards([]);
    setContext([]);
    setDeepeningId(null);
    suggestionsPausedRef.current = false;
    setSuggestionsPaused(false);
    transcriptMergeBoundaryRef.current = 0;
    setSystemAudioActive(false);
    setMicAudioActive(false);
    lastProcessedTsRef.current = 0;
    setError("");
    lsLog.info("Session reset — new session id:", sessionIdRef.current);
  }, []);

  const handleSetup = useCallback(async () => {
    try {
      const platform = navigator.platform.toLowerCase();
      if (platform.includes("mac") || platform.includes("win")) {
        await invoke("request_system_audio_access");
      }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const hasAccess = await invoke<boolean>("check_system_audio_access");
      if (hasAccess) {
        setSetupRequired(false);
        await start();
      } else {
        setSetupRequired(true);
        setError("Permission not granted. Please try the manual steps.");
      }
    } catch (err) {
      setError("Failed to request access. Please try the manual steps.");
      setSetupRequired(true);
    }
  }, [start]);

  // Expand to (nearly) full screen height while the panel is open; the regular
  // 600px expansion is too small for a live transcript + suggestions.
  const resizeForPanel = useCallback(
    async (open: boolean) => {
      try {
        if (!open) {
          setPanelHeight(0);
          // Use the shared collapse logic (guards against other open popovers).
          resizeWindow(false);
          return;
        }
        const win = getCurrentWebviewWindow();
        // availHeight is in CSS/logical px, matching set_window_height's LogicalSize.
        // Subtract the top offset (~54px) and a small bottom margin.
        const screenH = window.screen?.availHeight || 900;
        const height = Math.max(600, Math.floor(screenH - 54 - 16));
        await invoke("set_window_height", { window: win, height });
        // The popover sits ~62px below the window top (54px bar + 8px offset).
        setPanelHeight(Math.max(420, height - 64));
      } catch (error) {
        lsLog.error("Failed to resize Live Suggest window:", error);
      }
    },
    [resizeWindow]
  );

  useEffect(() => {
    resizeForPanel(isPanelOpen);
  }, [isPanelOpen, resizeForPanel]);

  // Persist the session to SQLite (debounced) as the transcript/suggestions
  // change, mirroring how chat conversations are saved.
  useEffect(() => {
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    // Persist once there's something worth saving (transcript or context).
    if (transcript.length === 0 && context.length === 0) return;

    saveTimeoutRef.current = setTimeout(async () => {
      if (isSavingRef.current) return;
      try {
        isSavingRef.current = true;
        await saveLiveSession(
          buildSession(
            sessionIdRef.current,
            sessionCreatedAtRef.current,
            transcript,
            cards,
            context
          )
        );
        lsLog.debug(
          `Session saved (${transcript.length} lines, ${cards.length} cards, ${context.length} context).`
        );
      } catch (err) {
        lsLog.error("Failed to save Live Suggest session:", err);
      } finally {
        isSavingRef.current = false;
      }
    }, CONVERSATION_SAVE_DEBOUNCE_MS);

    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, [transcript, cards, context]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      if (abortControllerRef.current) abortControllerRef.current.abort();
      if (deepenAbortRef.current) deepenAbortRef.current.abort();
      if (generationTimerRef.current) clearTimeout(generationTimerRef.current);
      invoke("stop_live_audio_capture").catch(() => {});
    };
  }, []);

  return {
    active,
    isPanelOpen,
    panelHeight,
    setIsPanelOpen,
    transcript,
    cards,
    context,
    deepeningId,
    isGenerating,
    suggestionsPaused,
    isTranscribing,
    systemAudioActive,
    micAudioActive,
    error,
    setupRequired,
    liveSuggestPromptId,
    setLiveSuggestPrompt,
    addContextText,
    addContextFiles,
    removeContext,
    clearContext,
    micDeviceId:
      selectedAudioDevices.input.id &&
      selectedAudioDevices.input.id !== "default"
        ? selectedAudioDevices.input.id
        : undefined,
    start,
    stop,
    reset,
    resume,
    toggleSuggestionsPaused,
    handleSetup,
    transcribeAndAppend,
    goDeeper,
  };
}
