import { useCallback, useRef, useState } from "react";
import { useApp } from "@/contexts";
import { fetchAIResponse } from "@/lib/functions";
import { shouldUsePluelyAPI, detectResponseError } from "@/lib";
import { updateLiveSessionSummary } from "@/lib/database";
import { LIVE_SUGGEST_SUMMARY_INSTRUCTIONS } from "@/config";
import type { LiveSession } from "@/types";

/** True when a session has at least one spoken transcript line to summarize. */
export const hasTranscript = (session: LiveSession | null): boolean =>
  !!session && session.items.some((i) => i.kind === "transcript");

// Build the user message for the summary: the formatted transcript, optionally
// preceded by any text/file background context attached to the session.
const buildSummaryUserMessage = (session: LiveSession): string => {
  const transcript = session.items
    .filter((i) => i.kind === "transcript")
    .map((i) => `${i.speaker === "you" ? "You" : "Them"}: ${i.content}`)
    .join("\n");

  const ctx = (session.context || [])
    .filter((c) => (c.kind === "text" || c.kind === "file") && c.text?.trim())
    .map((c) => `--- ${c.name} ---\n${c.text!.trim()}`)
    .join("\n\n");

  return `${
    ctx ? `Background context (reference material):\n${ctx}\n\n` : ""
  }Transcript:\n${transcript}`;
};

export type useLiveSummaryType = ReturnType<typeof useLiveSummary>;

/**
 * One-shot meeting summarization for the Live Suggest history view. Streams a
 * markdown summary from the selected AI provider, supports cancel/regenerate
 * via an AbortController, and persists the result on the session.
 */
export function useLiveSummary() {
  const { selectedAIProvider, allAiProviders, pluelyApiEnabled } = useApp();

  const [summary, setSummary] = useState<string>("");
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [error, setError] = useState<string>("");
  const abortRef = useRef<AbortController | null>(null);

  const hasAi = pluelyApiEnabled || !!selectedAIProvider.provider;

  const summarize = useCallback(
    async (session: LiveSession) => {
      if (!hasTranscript(session)) {
        setError("There's no transcript to summarize.");
        return;
      }

      // Abort any in-flight summarization (also powers "Regenerate").
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setError("");
      setSummary("");
      setIsSummarizing(true);

      try {
        const usePluelyAPI = await shouldUsePluelyAPI();
        if (!selectedAIProvider.provider && !usePluelyAPI) {
          setError("Please select an AI provider in settings.");
          return;
        }
        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !usePluelyAPI) {
          setError("Invalid AI provider selected.");
          return;
        }

        const userMessage = buildSummaryUserMessage(session);

        let full = "";
        for await (const chunk of fetchAIResponse({
          provider: usePluelyAPI ? undefined : provider,
          selectedProvider: selectedAIProvider,
          systemPrompt: LIVE_SUGGEST_SUMMARY_INSTRUCTIONS,
          history: [],
          userMessage,
          imagesBase64: [],
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) return;
          full += chunk;
          setSummary(full);
        }
        if (controller.signal.aborted) return;

        // fetchAIResponse surfaces API/network errors as content, not throws.
        const apiError = detectResponseError(full);
        if (apiError) {
          setError(`Summary failed: ${apiError}`);
          setSummary("");
          return;
        }

        // Persist so the summary survives navigation (non-fatal if it fails).
        try {
          await updateLiveSessionSummary(session.id, full);
        } catch {
          /* keep the in-memory summary even if persistence fails */
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setError(err?.message || "Failed to summarize the meeting.");
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        setIsSummarizing(false);
      }
    },
    [selectedAIProvider, allAiProviders]
  );

  const cancel = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsSummarizing(false);
  }, []);

  return {
    summary,
    setSummary,
    isSummarizing,
    error,
    hasAi,
    summarize,
    cancel,
  };
}
