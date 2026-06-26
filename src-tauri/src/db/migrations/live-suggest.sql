-- Live Suggest sessions: a chronological timeline of transcript lines and
-- AI suggestions captured during a hands-free listening session.
CREATE TABLE IF NOT EXISTS live_sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

-- A single timeline of items. `kind` distinguishes a spoken transcript line
-- from an AI suggestion, so suggestions can be embedded inline with the
-- transcript (Stage 2) without a schema change.
CREATE TABLE IF NOT EXISTS live_items (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('transcript', 'suggestion')),
    speaker TEXT,            -- 'you' | 'them' (transcript items)
    category TEXT,           -- suggestion category, e.g. 'term_explanation'
    title TEXT,              -- optional suggestion title
    content TEXT NOT NULL,   -- transcript text or suggestion body
    timestamp INTEGER NOT NULL,
    metadata TEXT,           -- JSON for future fields (anchors, actions, etc.)
    FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_sessions_updated_at ON live_sessions(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_live_items_session_id ON live_items(session_id);
CREATE INDEX IF NOT EXISTS idx_live_items_session_timestamp ON live_items(session_id, timestamp ASC);
