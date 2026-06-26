import { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import { MicIcon, HeadphonesIcon, SparklesIcon } from "lucide-react";
import { SuggestionCard } from "@/components";
import type { TranscriptLine } from "@/hooks/useLiveSuggest";
import type { SuggestionCard as SuggestionCardType } from "@/types";

interface LiveTimelineProps {
  transcript: TranscriptLine[];
  cards: SuggestionCardType[];
  isGenerating: boolean;
  isTranscribing: boolean;
  deepeningId: string | null;
  onGoDeeper: (cardId: string) => void;
}

type Entry =
  | { kind: "line"; ts: number; line: TranscriptLine }
  | { kind: "card"; ts: number; card: SuggestionCardType };

export const LiveTimeline = ({
  transcript,
  cards,
  isGenerating,
  isTranscribing,
  deepeningId,
  onGoDeeper,
}: LiveTimelineProps) => {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [transcript.length, cards.length, isTranscribing, isGenerating]);

  if (transcript.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <MicIcon className="h-4 w-4" />
          <span className="text-[11px]">You</span>
          <span className="text-[11px]">+</span>
          <HeadphonesIcon className="h-4 w-4" />
          <span className="text-[11px]">Them</span>
        </div>
        <p className="text-[11px] text-muted-foreground max-w-[260px]">
          Listening to your microphone and system audio. The conversation
          appears here and suggestions are added inline as you talk.
        </p>
      </div>
    );
  }

  const entries: Entry[] = [
    ...transcript.map<Entry>((line) => ({
      kind: "line",
      ts: line.timestamp,
      line,
    })),
    ...cards.map<Entry>((card) => ({ kind: "card", ts: card.timestamp, card })),
  ].sort((a, b) => a.ts - b.ts);

  return (
    <div className="space-y-2">
      {entries.map((entry) => {
        if (entry.kind === "card") {
          const { card } = entry;
          return (
            <div key={card.id} className="pl-3">
              <SuggestionCard
                compact
                family={card.family}
                categoryLabel={card.categoryLabel}
                title={card.title}
                body={card.body}
                deeper={card.deeper}
                isDeepening={deepeningId === card.id}
                onGoDeeper={() => onGoDeeper(card.id)}
              />
            </div>
          );
        }

        const { line } = entry;
        const isYou = line.speaker === "you";
        return (
          <div key={line.id} className="flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              {isYou ? (
                <MicIcon className="h-3 w-3 text-blue-600" />
              ) : (
                <HeadphonesIcon className="h-3 w-3 text-muted-foreground" />
              )}
              <span
                className={cn(
                  "text-[10px] font-semibold",
                  isYou ? "text-blue-700" : "text-foreground/70"
                )}
              >
                {isYou ? "You" : "Them"}
              </span>
            </div>
            <p className="text-[12px] leading-snug text-foreground/90 pl-[18px]">
              {line.text}
            </p>
          </div>
        );
      })}

      {(isTranscribing || isGenerating) && (
        <div className="flex items-center gap-1.5 px-1 py-1 text-[10px] text-muted-foreground">
          {isTranscribing ? (
            <>
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-green-500 animate-pulse" />
              Transcribing…
            </>
          ) : (
            <>
              <SparklesIcon className="h-3 w-3 animate-pulse text-primary" />
              Thinking of suggestions…
            </>
          )}
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
};
