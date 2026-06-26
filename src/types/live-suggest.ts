export type LiveItemKind = "transcript" | "suggestion";
export type LiveSpeaker = "you" | "them";

/** Stable visual families for dynamic, model-generated suggestion cards. */
export type SuggestionFamily =
  | "insight"
  | "risk"
  | "question"
  | "response"
  | "action"
  | "explanation"
  | "decision"
  | "opportunity";

/**
 * A discrete, categorized suggestion shown inline with the transcript.
 * Anchored to the transcript line it reacts to so it can be interleaved
 * chronologically (Stage 2).
 */
export interface SuggestionCard {
  id: string;
  family: SuggestionFamily;
  categoryId: string;
  categoryLabel: string;
  title: string;
  body: string;
  /** Transcript line this suggestion reacts to (for inline placement). */
  anchorLineId: string | null;
  timestamp: number;
  /** Expanded "Go deeper" elaboration, when the user requested one. */
  deeper?: string;
}

export interface LiveItem {
  id: string;
  kind: LiveItemKind;
  /** Transcript items: who spoke. */
  speaker?: LiveSpeaker | null;
  /** Suggestion items: stable visual family, e.g. "risk", "question". */
  category?: string | null;
  /** Suggestion items: optional short title. */
  title?: string | null;
  /** Transcript text or suggestion body. */
  content: string;
  timestamp: number;
  /** JSON-serializable extras for future use (anchors, actions, etc.). */
  metadata?: Record<string, unknown> | null;
}

/**
 * Kinds of background context a user can attach to a live session.
 * - `text`: free text typed or pasted in.
 * - `file`: a text-based file (.txt, .md, .csv, …) read as plain text.
 * - `image`: an image passed to a vision-capable model as base64.
 */
export type LiveContextKind = "text" | "file" | "image";

/**
 * A single piece of background context injected into a live session so the
 * model's suggestions are grounded in material the user provides (agenda, job
 * description, notes, a screenshot, etc.). Stored per-session and restored on
 * resume.
 */
export interface LiveContextItem {
  id: string;
  kind: LiveContextKind;
  /** Display label — "Note" for typed text, the filename for files/images. */
  name: string;
  /** Extracted text for `text`/`file` kinds (empty for images). */
  text?: string;
  /** Raw base64 (no data-URL prefix) for the `image` kind. */
  imageBase64?: string;
  /** MIME type for the `image` kind, e.g. "image/png". */
  mimeType?: string;
  timestamp: number;
}

export interface LiveSession {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  items: LiveItem[];
  /** Background context attached to this session (per-session, optional). */
  context?: LiveContextItem[];
  /** AI-generated meeting summary (markdown), generated on demand. */
  summary?: string;
}

export interface LiveSessionChatMessage {
  id: string;
  sessionId: string;
  parentId?: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}
