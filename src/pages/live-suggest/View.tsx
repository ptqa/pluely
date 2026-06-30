import {
  Empty,
  Button,
  SuggestionCard,
  Markdown,
  Textarea,
  CopyButton,
} from "@/components";
import { getLiveSessionById, deleteLiveSession } from "@/lib/database";
import { resumeLiveSuggest } from "@/lib";
import type { LiveSession } from "@/types";
import {
  WandSparklesIcon,
  Trash2,
  MicIcon,
  HeadphonesIcon,
  PlayIcon,
  PaperclipIcon,
  FileTextIcon,
  ImageIcon,
  StickyNoteIcon,
  LoaderIcon,
  SendIcon,
  MessageCircleIcon,
  UserIcon,
  BotIcon,
  PencilIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CheckIcon,
  XIcon,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import moment from "moment";
import { useParams, useNavigate } from "react-router-dom";
import { PageLayout } from "@/layouts";
import { cn } from "@/lib/utils";
import {
  LIVE_SESSION_CHAT_QUICK_PROMPTS,
  type UseLiveSessionChatType,
  useLiveSessionChat,
} from "@/hooks";

const View = () => {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<LiveSession | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editInput, setEditInput] = useState("");
  const chatEndRef = useRef<HTMLDivElement>(null);
  const chat = useLiveSessionChat(session);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const result = await getLiveSessionById(sessionId as string);
        if (!mounted) return;
        setSession(result);
      } catch (err) {
        console.error("Failed to load Live Suggest session:", err);
      } finally {
        if (mounted) setIsLoading(false);
      }
    })();
    return () => {
      mounted = false;
    };
  }, [sessionId]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chat.messages.length]);

  const handleDelete = async () => {
    if (!sessionId) return;
    await deleteLiveSession(sessionId);
    navigate(-1);
  };

  const handleResume = async () => {
    if (!sessionId) return;
    await resumeLiveSuggest(sessionId);
  };

  const beginEditMessage = (messageId: string, content: string) => {
    setEditingMessageId(messageId);
    setEditInput(content);
  };

  const cancelEditMessage = () => {
    setEditingMessageId(null);
    setEditInput("");
  };

  const saveEditedMessage = async () => {
    if (!editingMessageId || !editInput.trim()) return;
    const messageId = editingMessageId;
    const content = editInput;
    cancelEditMessage();
    await chat.editMessage(messageId, content);
  };

  const transcriptCount = useMemo(
    () => session?.items.filter((i) => i.kind === "transcript").length ?? 0,
    [session?.items]
  );
  const suggestionCount = useMemo(
    () => session?.items.filter((i) => i.kind === "suggestion").length ?? 0,
    [session?.items]
  );
  const contextCount = session?.context?.length ?? 0;
  const hasSessionMaterial =
    !!session && (session.items.length > 0 || contextCount > 0);

  return (
    <PageLayout
      isMainTitle={false}
      allowBackButton={true}
      title={session?.title || "Live Suggest session"}
      description={`${transcriptCount} transcript lines`}
      rightSlot={
        <div className="flex items-center gap-2">
          <Button
            title="Resume this session"
            onClick={handleResume}
            className="text-[10px] lg:text-sm h-6 lg:h-8"
          >
            Resume <PlayIcon className="size-3 lg:size-4" />
          </Button>
          <Button
            variant="destructive"
            title="Delete session"
            onClick={handleDelete}
            className="text-[10px] lg:text-sm h-6 lg:h-8"
          >
            Delete <Trash2 className="size-3 lg:size-4" />
          </Button>
        </div>
      }
    >
      {!session ||
      (session.items.length === 0 &&
        (!session.context || session.context.length === 0)) ? (
        <Empty
          isLoading={isLoading}
          icon={WandSparklesIcon}
          title="Nothing recorded"
          description="This session has no transcript or suggestions"
        />
      ) : (
        <div className="flex flex-col gap-3 pb-64 px-2 max-w-3xl mx-auto w-full">
          <SessionContextList context={session.context} />
          <SessionItems items={session.items} />
          {(chat.isLoadingMessages || chat.messages.length > 0 || chat.error) && (
            <div className="mt-4 flex flex-col gap-2 border-t border-border/60 pt-4">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-muted-foreground">
                <MessageCircleIcon className="size-3.5" />
                Session chat
              </div>
              {chat.isLoadingMessages && (
                <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <LoaderIcon className="size-3 animate-spin" />
                  Loading chat…
                </div>
              )}
              {chat.messages.map((message) => {
                const isUser = message.role === "user";
                const isEditing = editingMessageId === message.id;
                const branchInfo = isUser ? chat.getBranchInfo(message.id) : null;
                return (
                  <div
                    key={message.id}
                    className={cn(
                      "flex gap-2",
                      isUser ? "justify-end" : "justify-start"
                    )}
                  >
                    {!isUser && (
                      <div className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-primary/30 bg-primary/10 text-primary">
                        <BotIcon className="size-3.5" />
                      </div>
                    )}
                    <div className="flex max-w-[86%] flex-col gap-1">
                      <div
                        className={cn(
                          "rounded-2xl border px-3 py-2 text-sm shadow-sm",
                          isUser
                            ? "border-blue-500/30 bg-blue-500/10 text-foreground"
                            : "border-border/70 bg-card/80 text-foreground"
                        )}
                      >
                        {isEditing ? (
                          <div className="flex flex-col gap-2">
                            <Textarea
                              value={editInput}
                              onChange={(e) => setEditInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  saveEditedMessage();
                                }
                                if (e.key === "Escape") cancelEditMessage();
                              }}
                              rows={3}
                              autoFocus
                              className="min-h-20 resize-none rounded-xl bg-background/80 text-sm"
                            />
                            <div className="flex justify-end gap-1.5">
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-7 px-2 text-[11px]"
                                onClick={cancelEditMessage}
                              >
                                <XIcon className="size-3" />
                                Cancel
                              </Button>
                              <Button
                                size="sm"
                                className="h-7 px-2 text-[11px]"
                                disabled={!editInput.trim() || chat.isLoading}
                                onClick={saveEditedMessage}
                              >
                                <CheckIcon className="size-3" />
                                Save
                              </Button>
                            </div>
                          </div>
                        ) : message.content ? (
                          isUser ? (
                            <p className="whitespace-pre-wrap leading-snug">
                              {message.content}
                            </p>
                          ) : (
                            <Markdown isStreaming={chat.isLoading}>{message.content}</Markdown>
                          )
                        ) : (
                          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                            <LoaderIcon className="size-3 animate-spin" />
                            Thinking…
                          </div>
                        )}
                      </div>
                      {!isEditing && (
                        <div
                          className={cn(
                            "flex items-center gap-1 text-muted-foreground",
                            isUser ? "justify-end" : "justify-start"
                          )}
                        >
                          {message.content && (
                            <CopyButton
                              content={message.content}
                              copyMessage="Message copied to clipboard"
                            />
                          )}
                          {isUser && (
                            <Button
                              size="icon"
                              variant="ghost"
                              className="size-6"
                              title="Edit message"
                              disabled={chat.isLoading}
                              onClick={() =>
                                beginEditMessage(message.id, message.content)
                              }
                            >
                              <PencilIcon className="size-3.5" />
                            </Button>
                          )}
                          {branchInfo && (
                            <div className="ml-0.5 flex items-center gap-0.5 text-[11px] font-medium">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-6"
                                title="Previous version"
                                disabled={!branchInfo.canGoPrevious || chat.isLoading}
                                onClick={() => chat.switchBranch(message.id, -1)}
                              >
                                <ChevronLeftIcon className="size-3.5" />
                              </Button>
                              <span className="min-w-7 text-center">
                                {branchInfo.index + 1}/{branchInfo.total}
                              </span>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="size-6"
                                title="Next version"
                                disabled={!branchInfo.canGoNext || chat.isLoading}
                                onClick={() => chat.switchBranch(message.id, 1)}
                              >
                                <ChevronRightIcon className="size-3.5" />
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                    {isUser && (
                      <div className="mt-1 flex size-6 shrink-0 items-center justify-center rounded-full border border-blue-500/30 bg-blue-500/10 text-blue-600">
                        <UserIcon className="size-3.5" />
                      </div>
                    )}
                  </div>
                );
              })}
              {chat.error && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  {chat.error}
                </div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>
      )}
      {hasSessionMaterial && (
        <LiveSessionChatComposer
          transcriptCount={transcriptCount}
          suggestionCount={suggestionCount}
          contextCount={contextCount}
          hasAi={chat.hasAi}
          isLoading={chat.isLoading}
          onSubmit={chat.submit}
          onStop={chat.stop}
        />
      )}
    </PageLayout>
  );
};

type SessionContextListProps = {
  context: LiveSession["context"];
};

const SessionContextList = memo(({ context }: SessionContextListProps) => {
  if (!context?.length) return null;

  return (
    <div className="rounded-lg border border-border/60 bg-muted/30 p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <PaperclipIcon className="size-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold">Context ({context.length})</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {context.map((c) => (
          <span
            key={c.id}
            className="inline-flex items-center gap-1 rounded-md border border-border/60 bg-background px-2 py-1 text-[11px]"
            title={c.kind === "image" ? c.name : (c.text || "").slice(0, 400)}
          >
            {c.kind === "image" ? (
              <ImageIcon className="size-3 text-muted-foreground" />
            ) : c.kind === "file" ? (
              <FileTextIcon className="size-3 text-muted-foreground" />
            ) : (
              <StickyNoteIcon className="size-3 text-muted-foreground" />
            )}
            {c.name}
          </span>
        ))}
      </div>
    </div>
  );
});

type SessionItemsProps = {
  items: LiveSession["items"];
};

const SessionItems = memo(({ items }: SessionItemsProps) => {
  return (
    <>
      {items.map((item) => {
        if (item.kind === "suggestion") {
          const family = item.category || "insight";
          const categoryLabel =
            item.metadata && typeof item.metadata.categoryLabel === "string"
              ? item.metadata.categoryLabel
              : "Suggestion";
          const deeper =
            item.metadata && typeof item.metadata.deeper === "string"
              ? (item.metadata.deeper as string)
              : undefined;
          return (
            <div key={item.id} className="pl-4">
              <SuggestionCard
                family={family}
                categoryLabel={categoryLabel}
                title={item.title || ""}
                body={item.content}
                deeper={deeper}
              />
            </div>
          );
        }

        const isYou = item.speaker === "you";
        return (
          <div key={item.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {isYou ? (
                <MicIcon className="size-3 text-blue-600" />
              ) : (
                <HeadphonesIcon className="size-3 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "text-[11px] font-semibold",
                  isYou ? "text-blue-700" : "text-foreground/70"
                )}
              >
                {isYou ? "You" : "Them"}
              </span>
              <span className="text-[10px] text-muted-foreground">
                {moment(item.timestamp).format("hh:mm A")}
              </span>
            </div>
            <p className="text-sm leading-snug text-foreground/90 pl-[18px]">
              {item.content}
            </p>
          </div>
        );
      })}
    </>
  );
});

type LiveSessionChatComposerProps = {
  transcriptCount: number;
  suggestionCount: number;
  contextCount: number;
  hasAi: UseLiveSessionChatType["hasAi"];
  isLoading: UseLiveSessionChatType["isLoading"];
  onSubmit: UseLiveSessionChatType["submit"];
  onStop: UseLiveSessionChatType["stop"];
};

const LiveSessionChatComposer = ({
  transcriptCount,
  suggestionCount,
  contextCount,
  hasAi,
  isLoading,
  onSubmit,
  onStop,
}: LiveSessionChatComposerProps) => {
  const [input, setInput] = useState("");
  const trimmedInput = input.trim();

  const submitInput = () => {
    if (!trimmedInput || isLoading || !hasAi) return;
    setInput("");
    void onSubmit(trimmedInput);
  };

  const submitQuickPrompt = (prompt: string) => {
    if (isLoading || !hasAi) return;
    setInput("");
    void onSubmit(prompt);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitInput();
    }
  };

  return (
    <div className="pointer-events-none absolute bottom-0 left-0 right-0 bg-gradient-to-t from-background via-background/95 to-background/0 px-3 pb-4 pt-14">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-2xl border border-border/70 bg-card/95 p-2 shadow-2xl backdrop-blur-xl">
        <div className="mb-2 flex flex-wrap items-center gap-1.5 px-1">
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/20 bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
            <MessageCircleIcon className="size-3" />
            Included
          </span>
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
            {transcriptCount} transcript lines
          </span>
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
            {suggestionCount} cards
          </span>
          <span className="rounded-full border border-border/70 bg-background/70 px-2 py-1 text-[10px] text-muted-foreground">
            {contextCount} context items
          </span>
        </div>
        <div className="mb-2 flex flex-wrap gap-1.5 px-1">
          {LIVE_SESSION_CHAT_QUICK_PROMPTS.map((prompt) => (
            <Button
              key={prompt}
              type="button"
              size="sm"
              variant="outline"
              className="h-6 rounded-full px-2 text-[10px]"
              onClick={() => submitQuickPrompt(prompt)}
              disabled={isLoading || !hasAi}
            >
              {prompt}
            </Button>
          ))}
        </div>
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              hasAi
                ? "Ask about this session..."
                : "Select an AI provider in settings to chat"
            }
            rows={2}
            disabled={isLoading || !hasAi}
            className="min-h-20 resize-none rounded-xl bg-background/80 pr-12 text-sm"
          />
          <Button
            size="icon"
            className="absolute bottom-2 right-2 size-8 rounded-xl"
            title={isLoading ? "Stop generating" : "Send message"}
            onClick={() => (isLoading ? onStop() : submitInput())}
            disabled={!isLoading && (!trimmedInput || !hasAi)}
          >
            {isLoading ? (
              <LoaderIcon className="size-4 animate-spin" />
            ) : (
              <SendIcon className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
};

export default View;
