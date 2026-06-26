import { Markdown } from "@/components/Markdown";
import { cn } from "@/lib/utils";
import type { SuggestionFamily } from "@/types";
import {
  MessageSquareIcon,
  HelpCircleIcon,
  ListChecksIcon,
  PinIcon,
  SparklesIcon,
  Loader2Icon,
  AlertTriangleIcon,
  GitBranchIcon,
  TrendingUpIcon,
  BookTextIcon,
  type LucideIcon,
} from "lucide-react";

interface CategoryStyle {
  label: string;
  Icon: LucideIcon;
  /** Left accent border colour. */
  accent: string;
  /** Badge background + text colour. */
  badge: string;
}

const FAMILY_STYLES: Record<SuggestionFamily, CategoryStyle> = {
  insight: {
    label: "Insight",
    Icon: PinIcon,
    accent: "border-l-sky-500",
    badge: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  },
  risk: {
    label: "Risk",
    Icon: AlertTriangleIcon,
    accent: "border-l-red-500",
    badge: "bg-red-500/15 text-red-600 dark:text-red-400",
  },
  question: {
    label: "Question",
    Icon: HelpCircleIcon,
    accent: "border-l-violet-500",
    badge: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
  },
  response: {
    label: "Response",
    Icon: MessageSquareIcon,
    accent: "border-l-emerald-500",
    badge: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  },
  action: {
    label: "Action",
    Icon: ListChecksIcon,
    accent: "border-l-blue-500",
    badge: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  },
  explanation: {
    label: "Explanation",
    Icon: BookTextIcon,
    accent: "border-l-amber-500",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  },
  decision: {
    label: "Decision",
    Icon: GitBranchIcon,
    accent: "border-l-indigo-500",
    badge: "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400",
  },
  opportunity: {
    label: "Opportunity",
    Icon: TrendingUpIcon,
    accent: "border-l-green-500",
    badge: "bg-green-500/15 text-green-600 dark:text-green-400",
  },
};

const FALLBACK_STYLE: CategoryStyle = {
  label: "Suggestion",
  Icon: SparklesIcon,
  accent: "border-l-primary",
  badge: "bg-primary/15 text-primary",
};

export interface SuggestionCardProps {
  family: string;
  categoryLabel: string;
  title: string;
  body: string;
  /** Expanded elaboration, when present, is shown under the body. */
  deeper?: string;
  /** Provide to render an interactive "Go deeper" action. */
  onGoDeeper?: () => void;
  /** Shows a spinner on the action while an elaboration is generating. */
  isDeepening?: boolean;
  /** Smaller paddings/text for the compact overlay panel. */
  compact?: boolean;
  /** Animate markdown while content is still streaming in. */
  isStreaming?: boolean;
  className?: string;
}

export const SuggestionCard = ({
  family,
  categoryLabel,
  title,
  body,
  deeper,
  onGoDeeper,
  isDeepening = false,
  compact = false,
  isStreaming = false,
  className,
}: SuggestionCardProps) => {
  const style = FAMILY_STYLES[family as SuggestionFamily] || FALLBACK_STYLE;
  const { Icon } = style;
  const hasDeeper = !!deeper && deeper.trim().length > 0;
  const label = categoryLabel.trim() || style.label;

  return (
    <div
      className={cn(
        "rounded-md border border-l-4 bg-card/60 overflow-hidden",
        style.accent,
        className
      )}
    >
      <div className={cn("flex flex-col", compact ? "p-2.5 gap-1.5" : "p-4 gap-2")}>
        {/* Header: category badge + title */}
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded font-medium",
              style.badge,
              compact ? "px-1.5 py-0.5 text-[10px]" : "px-2 py-0.5 text-xs"
            )}
          >
            <Icon className={compact ? "size-3" : "size-3.5"} />
            {label}
          </span>
          {title && (
            <span
              className={cn(
                "font-semibold leading-tight",
                compact ? "text-[12px]" : "text-sm"
              )}
            >
              {title}
            </span>
          )}
        </div>

        {/* Body */}
        <div className={compact ? "text-[12px]" : "text-sm"}>
          <Markdown isStreaming={isStreaming}>{body}</Markdown>
        </div>

        {/* Expanded elaboration */}
        {hasDeeper && (
          <div
            className={cn(
              "mt-1 rounded border-l-2 border-primary/30 bg-primary/[0.04] pl-2.5",
              compact ? "py-1.5 text-[12px]" : "py-2 text-sm"
            )}
          >
            <Markdown isStreaming={isDeepening}>{deeper!}</Markdown>
          </div>
        )}
      </div>

      {/* Go deeper action */}
      {onGoDeeper && (
        <button
          type="button"
          onClick={onGoDeeper}
          disabled={isDeepening}
          className={cn(
            "flex w-full items-center gap-1.5 border-t border-border/50 text-muted-foreground transition-colors hover:text-primary hover:bg-primary/[0.04] disabled:opacity-60 disabled:hover:bg-transparent",
            compact ? "px-2.5 py-1.5 text-[11px]" : "px-4 py-2 text-xs"
          )}
        >
          {isDeepening ? (
            <Loader2Icon className={cn("animate-spin", compact ? "size-3" : "size-3.5")} />
          ) : (
            <SparklesIcon className={compact ? "size-3" : "size-3.5"} />
          )}
          {isDeepening ? "Thinking…" : hasDeeper ? "Regenerate" : "Go deeper"}
        </button>
      )}
    </div>
  );
};
