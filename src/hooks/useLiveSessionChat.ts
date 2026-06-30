import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/contexts";
import { LIVE_SUGGEST_HISTORY_CHAT_INSTRUCTIONS } from "@/config";
import {
  detectResponseError,
  fetchAIResponse,
  generateMessageId,
  MESSAGE_ID_OFFSET,
  shouldUsePluelyAPI,
} from "@/lib";
import {
  getLiveSessionChatMessages,
  upsertLiveSessionChatMessage,
} from "@/lib/database";
import type { LiveSession, LiveSessionChatMessage, Message } from "@/types";

export const LIVE_SESSION_CHAT_QUICK_PROMPTS = [
  "Summarize this",
  "Find weak answers",
  "Extract action items",
  "Improve my responses",
] as const;

const ROOT_PARENT_KEY = "__root__";
const STREAM_UPDATE_INTERVAL_MS = 80;

const getParentKey = (parentId?: string | null): string =>
  parentId || ROOT_PARENT_KEY;

const sortMessages = (messages: LiveSessionChatMessage[]) =>
  [...messages].sort((a, b) => a.timestamp - b.timestamp);

const normalizeLegacyFlatMessages = (
  messages: LiveSessionChatMessage[]
): LiveSessionChatMessage[] => {
  const sorted = sortMessages(messages);
  if (sorted.length === 0 || sorted.some((message) => message.parentId)) {
    return sorted;
  }

  return sorted.map((message, index) => ({
    ...message,
    parentId: index === 0 ? null : sorted[index - 1].id,
  }));
};

const buildVisiblePath = (
  messages: LiveSessionChatMessage[],
  activeChildByParent: Record<string, string>
): LiveSessionChatMessage[] => {
  const byParent = new Map<string, LiveSessionChatMessage[]>();
  for (const message of sortMessages(messages)) {
    const parentKey = getParentKey(message.parentId);
    const siblings = byParent.get(parentKey) || [];
    siblings.push(message);
    byParent.set(parentKey, siblings);
  }

  const path: LiveSessionChatMessage[] = [];
  let parentKey = ROOT_PARENT_KEY;
  const visited = new Set<string>();

  while (!visited.has(parentKey)) {
    visited.add(parentKey);
    const children = byParent.get(parentKey);
    if (!children || children.length === 0) break;

    const activeChildId = activeChildByParent[parentKey];
    const child =
      children.find((message) => message.id === activeChildId) ||
      children[children.length - 1];
    path.push(child);
    parentKey = child.id;
  }

  return path;
};

const formatSessionMaterial = (session: LiveSession): string => {
  const context = (session.context || [])
    .map((item) => {
      if (item.kind === "image") return `--- ${item.name} ---\n[Attached image]`;
      return `--- ${item.name} ---\n${item.text?.trim() || "[No text]"}`;
    })
    .join("\n\n");

  const transcript = session.items
    .filter((item) => item.kind === "transcript")
    .map((item) => `${item.speaker === "you" ? "You" : "Them"}: ${item.content}`)
    .join("\n");

  const cards = session.items
    .filter((item) => item.kind === "suggestion")
    .map((item) => {
      const label =
        item.metadata && typeof item.metadata.categoryLabel === "string"
          ? item.metadata.categoryLabel
          : item.category || "Suggestion";
      const deeper =
        item.metadata && typeof item.metadata.deeper === "string"
          ? `\nDeeper: ${item.metadata.deeper}`
          : "";
      return `- [${label}] ${item.title || "Untitled"}: ${item.content}${deeper}`;
    })
    .join("\n");

  return [
    context ? `Background context:\n${context}` : "Background context: none",
    transcript ? `Transcript:\n${transcript}` : "Transcript: none",
    cards ? `Suggestion cards:\n${cards}` : "Suggestion cards: none",
  ].join("\n\n");
};

const getSessionImages = (session: LiveSession): string[] =>
  (session.context || [])
    .filter((item) => item.kind === "image" && item.imageBase64)
    .map((item) => item.imageBase64 as string);

export type UseLiveSessionChatType = ReturnType<typeof useLiveSessionChat>;

export function useLiveSessionChat(session: LiveSession | null) {
  const { selectedAIProvider, allAiProviders, pluelyApiEnabled } = useApp();

  const [allMessages, setAllMessages] = useState<LiveSessionChatMessage[]>([]);
  const [activeChildByParent, setActiveChildByParent] = useState<
    Record<string, string>
  >({});
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMessages, setIsLoadingMessages] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const allMessagesRef = useRef<LiveSessionChatMessage[]>([]);

  const hasAi = pluelyApiEnabled || !!selectedAIProvider.provider;

  useEffect(() => {
    allMessagesRef.current = allMessages;
  }, [allMessages]);

  const messages = useMemo(
    () => buildVisiblePath(allMessages, activeChildByParent),
    [activeChildByParent, allMessages]
  );
  const sessionSystemPrompt = useMemo(
    () =>
      session
        ? `${LIVE_SUGGEST_HISTORY_CHAT_INSTRUCTIONS}\n\nSession material:\n${formatSessionMaterial(
            session
          )}`
        : "",
    [session]
  );
  const sessionImages = useMemo(
    () => (session ? getSessionImages(session) : []),
    [session]
  );

  useEffect(() => {
    let mounted = true;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setError("");
    setAllMessages([]);
    setActiveChildByParent({});
    if (!session?.id) return;

    setIsLoadingMessages(true);
    getLiveSessionChatMessages(session.id)
      .then((result) => {
        if (mounted) setAllMessages(normalizeLegacyFlatMessages(result));
      })
      .catch((err) => {
        console.error("Failed to load Live Suggest chat messages:", err);
        if (mounted) setError("Failed to load chat history.");
      })
      .finally(() => {
        if (mounted) setIsLoadingMessages(false);
      });

    return () => {
      mounted = false;
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [session?.id]);

  const stop = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
    setIsLoading(false);
  }, []);

  const runPrompt = useCallback(
    async (
      prompt: string,
      parentId: string | null,
      historyMessages: LiveSessionChatMessage[]
    ) => {
      if (!session) return;
      const trimmedPrompt = prompt.trim();
      if (!trimmedPrompt || isLoading) return;

      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      const timestamp = Date.now();
      const userMessage: LiveSessionChatMessage = {
        id: generateMessageId("user", timestamp),
        sessionId: session.id,
        parentId,
        role: "user",
        content: trimmedPrompt,
        timestamp,
      };
      const assistantMessage: LiveSessionChatMessage = {
        id: generateMessageId("assistant", timestamp + MESSAGE_ID_OFFSET),
        sessionId: session.id,
        parentId: userMessage.id,
        role: "assistant",
        content: "",
        timestamp: timestamp + MESSAGE_ID_OFFSET,
      };

      const history: Message[] = historyMessages.map((message) => ({
        role: message.role,
        content: message.content,
      }));

      setAllMessages((prev) => [...prev, userMessage, assistantMessage]);
      setActiveChildByParent((prev) => ({
        ...prev,
        [getParentKey(parentId)]: userMessage.id,
        [userMessage.id]: assistantMessage.id,
      }));
      setError("");
      setIsLoading(true);
      await upsertLiveSessionChatMessage(userMessage);

      let full = "";
      let flushTimer: number | null = null;
      const updateAssistantContent = () => {
        setAllMessages((prev) =>
          prev.map((message) =>
            message.id === assistantMessage.id
              ? { ...message, content: full }
              : message
          )
        );
      };
      const scheduleAssistantUpdate = () => {
        if (flushTimer != null) return;
        flushTimer = window.setTimeout(() => {
          flushTimer = null;
          updateAssistantContent();
        }, STREAM_UPDATE_INTERVAL_MS);
      };

      try {
        const usePluelyAPI = await shouldUsePluelyAPI();
        if (!selectedAIProvider.provider && !usePluelyAPI) {
          setError("Please select an AI provider in settings.");
          setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
          return;
        }

        const provider = allAiProviders.find(
          (p) => p.id === selectedAIProvider.provider
        );
        if (!provider && !usePluelyAPI) {
          setError("Invalid AI provider selected.");
          setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
          return;
        }

        for await (const chunk of fetchAIResponse({
          provider: usePluelyAPI ? undefined : provider,
          selectedProvider: selectedAIProvider,
          systemPrompt: sessionSystemPrompt,
          history,
          userMessage: trimmedPrompt,
          imagesBase64: sessionImages,
          signal: controller.signal,
        })) {
          if (controller.signal.aborted) break;
          full += chunk;
          scheduleAssistantUpdate();
        }

        if (flushTimer != null) {
          window.clearTimeout(flushTimer);
          flushTimer = null;
        }
        if (full) {
          updateAssistantContent();
        }

        if (controller.signal.aborted) {
          if (full.trim()) {
            await upsertLiveSessionChatMessage({
              ...assistantMessage,
              content: full,
            });
          } else {
            setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
          }
          return;
        }

        const apiError = detectResponseError(full);
        if (apiError) {
          setError(`Chat failed: ${apiError}`);
          setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
          return;
        }

        if (full.trim()) {
          await upsertLiveSessionChatMessage({
            ...assistantMessage,
            content: full,
          });
        } else {
          setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        }
      } catch (err: any) {
        if (!controller.signal.aborted) {
          setError(err?.message || "Failed to chat about this session.");
          setAllMessages((prev) => prev.filter((m) => m.id !== assistantMessage.id));
        }
      } finally {
        if (flushTimer != null) {
          window.clearTimeout(flushTimer);
        }
        if (abortRef.current === controller) abortRef.current = null;
        setIsLoading(false);
      }
    },
    [
      allAiProviders,
      isLoading,
      selectedAIProvider,
      session,
      sessionImages,
      sessionSystemPrompt,
    ]
  );

  const submit = useCallback(
    async (nextPrompt: string) => {
      const prompt = nextPrompt.trim();
      if (!prompt) return;
      const parentId = messages[messages.length - 1]?.id ?? null;
      await runPrompt(prompt, parentId, messages);
    },
    [messages, runPrompt]
  );

  const editMessage = useCallback(
    async (messageId: string, content: string) => {
      const messageIndex = messages.findIndex((message) => message.id === messageId);
      const message = messages[messageIndex];
      if (!message || message.role !== "user") return;
      await runPrompt(content, message.parentId ?? null, messages.slice(0, messageIndex));
    },
    [messages, runPrompt]
  );

  const getBranchInfo = useCallback(
    (messageId: string) => {
      const message = allMessages.find((item) => item.id === messageId);
      if (!message) return null;
      const siblings = sortMessages(
        allMessages.filter(
          (item) =>
            item.role === message.role &&
            getParentKey(item.parentId) === getParentKey(message.parentId)
        )
      );
      const index = siblings.findIndex((item) => item.id === messageId);
      if (index < 0 || siblings.length <= 1) return null;
      return {
        index,
        total: siblings.length,
        canGoPrevious: index > 0,
        canGoNext: index < siblings.length - 1,
      };
    },
    [allMessages]
  );

  const switchBranch = useCallback((messageId: string, direction: -1 | 1) => {
    const message = allMessagesRef.current.find((item) => item.id === messageId);
    if (!message) return;
    const siblings = sortMessages(
      allMessagesRef.current.filter(
        (item) =>
          item.role === message.role &&
          getParentKey(item.parentId) === getParentKey(message.parentId)
      )
    );
    const index = siblings.findIndex((item) => item.id === messageId);
    const next = siblings[index + direction];
    if (!next) return;
    setActiveChildByParent((prev) => ({
      ...prev,
      [getParentKey(message.parentId)]: next.id,
    }));
  }, []);

  return {
    messages,
    isLoading,
    isLoadingMessages,
    error,
    hasAi,
    submit,
    editMessage,
    getBranchInfo,
    switchBranch,
    stop,
  };
}
