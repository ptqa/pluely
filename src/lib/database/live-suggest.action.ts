import { getDatabase } from "./config";
import type {
  LiveContextItem,
  LiveItem,
  LiveSession,
  LiveSessionChatMessage,
} from "@/types";

interface DbLiveSession {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  /** JSON-encoded LiveContextItem[]; only selected when loading a single session. */
  context?: string | null;
  /** Markdown meeting summary; only selected when loading a single session. */
  summary?: string | null;
}

interface DbLiveItem {
  id: string;
  session_id: string;
  kind: "transcript" | "suggestion";
  speaker: string | null;
  category: string | null;
  title: string | null;
  content: string;
  timestamp: number;
  metadata: string | null;
}

interface DbLiveSessionChatMessage {
  id: string;
  session_id: string;
  parent_id?: string | null;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

function safeJsonParse<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function rowToItem(row: DbLiveItem): LiveItem {
  return {
    id: row.id,
    kind: row.kind,
    speaker: (row.speaker as LiveItem["speaker"]) ?? null,
    category: row.category,
    title: row.title,
    content: row.content,
    timestamp: row.timestamp,
    metadata: safeJsonParse<Record<string, unknown> | null>(row.metadata, null),
  };
}

function rowToChatMessage(
  row: DbLiveSessionChatMessage
): LiveSessionChatMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    parentId: row.parent_id ?? null,
    role: row.role,
    content: row.content,
    timestamp: row.timestamp,
  };
}

function validateSession(session: LiveSession): boolean {
  return (
    !!session.id &&
    typeof session.id === "string" &&
    typeof session.title === "string" &&
    Array.isArray(session.items)
  );
}

/** Serialize a session's context array for storage (null when empty). */
function serializeContext(context?: LiveContextItem[]): string | null {
  return context && context.length > 0 ? JSON.stringify(context) : null;
}

async function insertItems(
  sessionId: string,
  items: LiveItem[]
): Promise<void> {
  const db = await getDatabase();
  for (const item of items) {
    if (!item.id || typeof item.content !== "string") continue;
    await db.execute(
      `INSERT INTO live_items
        (id, session_id, kind, speaker, category, title, content, timestamp, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id,
        sessionId,
        item.kind,
        item.speaker ?? null,
        item.category ?? null,
        item.title ?? null,
        item.content,
        item.timestamp,
        item.metadata ? JSON.stringify(item.metadata) : null,
      ]
    );
  }
}

export async function createLiveSession(
  session: LiveSession
): Promise<LiveSession> {
  if (!validateSession(session)) {
    throw new Error("Invalid live session data");
  }
  const db = await getDatabase();
  try {
    await db.execute(
      "INSERT INTO live_sessions (id, title, created_at, updated_at, context) VALUES (?, ?, ?, ?, ?)",
      [
        session.id,
        session.title,
        session.createdAt || Date.now(),
        session.updatedAt || Date.now(),
        serializeContext(session.context),
      ]
    );
    await insertItems(session.id, session.items);
    return session;
  } catch (error) {
    await db
      .execute("DELETE FROM live_sessions WHERE id = ?", [session.id])
      .catch(() => {});
    throw error;
  }
}

export async function updateLiveSession(
  session: LiveSession
): Promise<LiveSession> {
  if (!validateSession(session)) {
    throw new Error("Invalid live session data");
  }
  const db = await getDatabase();

  const result = await db.execute(
    "UPDATE live_sessions SET title = ?, updated_at = ?, context = ? WHERE id = ?",
    [
      session.title,
      session.updatedAt,
      serializeContext(session.context),
      session.id,
    ]
  );
  if (result.rowsAffected === 0) {
    throw new Error("Live session not found");
  }

  // Replace items wholesale (sessions are small and grow append-only).
  await db.execute("DELETE FROM live_items WHERE session_id = ?", [session.id]);
  await insertItems(session.id, session.items);
  return session;
}

export async function saveLiveSession(
  session: LiveSession
): Promise<LiveSession> {
  const existing = await getLiveSessionById(session.id);
  return existing ? updateLiveSession(session) : createLiveSession(session);
}

export async function getAllLiveSessions(): Promise<LiveSession[]> {
  const db = await getDatabase();
  // Exclude the (potentially large) context blob from the history list query;
  // it is only needed when a single session is opened/resumed.
  const sessions = await db.select<DbLiveSession[]>(
    "SELECT id, title, created_at, updated_at FROM live_sessions ORDER BY updated_at DESC"
  );
  if (sessions.length === 0) return [];

  const ids = sessions.map((s) => s.id);
  const placeholders = ids.map(() => "?").join(",");
  const items = await db.select<DbLiveItem[]>(
    `SELECT * FROM live_items WHERE session_id IN (${placeholders}) ORDER BY session_id, timestamp ASC`,
    ids
  );

  const itemsBySession = new Map<string, DbLiveItem[]>();
  for (const item of items) {
    if (!itemsBySession.has(item.session_id)) {
      itemsBySession.set(item.session_id, []);
    }
    itemsBySession.get(item.session_id)!.push(item);
  }

  return sessions.map((s) => ({
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    items: (itemsBySession.get(s.id) || []).map(rowToItem),
  }));
}

export async function getLiveSessionById(
  id: string
): Promise<LiveSession | null> {
  if (!id) return null;
  const db = await getDatabase();
  const sessions = await db.select<DbLiveSession[]>(
    "SELECT * FROM live_sessions WHERE id = ?",
    [id]
  );
  if (sessions.length === 0) return null;
  const s = sessions[0];
  const items = await db.select<DbLiveItem[]>(
    "SELECT * FROM live_items WHERE session_id = ? ORDER BY timestamp ASC",
    [id]
  );
  return {
    id: s.id,
    title: s.title,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    items: items.map(rowToItem),
    context: safeJsonParse<LiveContextItem[]>(s.context ?? null, []),
    summary: s.summary ?? undefined,
  };
}

/**
 * Persist (or clear) the AI-generated summary for a session. Targeted update
 * that leaves transcript items, context, and updated_at untouched so it never
 * clobbers an in-progress session being saved from the overlay.
 */
export async function updateLiveSessionSummary(
  id: string,
  summary: string
): Promise<void> {
  if (!id) return;
  const db = await getDatabase();
  await db.execute("UPDATE live_sessions SET summary = ? WHERE id = ?", [
    summary && summary.trim() ? summary : null,
    id,
  ]);
}

export async function getLiveSessionChatMessages(
  sessionId: string
): Promise<LiveSessionChatMessage[]> {
  if (!sessionId) return [];
  const db = await getDatabase();
  const rows = await db.select<DbLiveSessionChatMessage[]>(
    "SELECT * FROM live_session_chat_messages WHERE session_id = ? ORDER BY timestamp ASC",
    [sessionId]
  );
  return rows.map(rowToChatMessage);
}

export async function upsertLiveSessionChatMessage(
  message: LiveSessionChatMessage
): Promise<void> {
  if (!message.id || !message.sessionId) return;
  const db = await getDatabase();
  await db.execute(
    `INSERT INTO live_session_chat_messages (id, session_id, parent_id, role, content, timestamp)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET parent_id = excluded.parent_id, content = excluded.content, timestamp = excluded.timestamp`,
    [
      message.id,
      message.sessionId,
      message.parentId ?? null,
      message.role,
      message.content,
      message.timestamp,
    ]
  );
}

export async function deleteLiveSessionChatMessages(
  sessionId: string
): Promise<void> {
  if (!sessionId) return;
  const db = await getDatabase();
  await db.execute("DELETE FROM live_session_chat_messages WHERE session_id = ?", [
    sessionId,
  ]);
}

export async function deleteLiveSession(id: string): Promise<boolean> {
  if (!id) return false;
  const db = await getDatabase();
  const result = await db.execute("DELETE FROM live_sessions WHERE id = ?", [
    id,
  ]);
  return result.rowsAffected > 0;
}

export async function deleteAllLiveSessions(): Promise<void> {
  const db = await getDatabase();
  await db.execute("DELETE FROM live_session_chat_messages");
  await db.execute("DELETE FROM live_items");
  await db.execute("DELETE FROM live_sessions");
}
