-- Persist chat Q&A attached to a Live Suggest history session. These messages
-- are separate from the captured transcript/suggestion timeline.
CREATE TABLE IF NOT EXISTS live_session_chat_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
    content TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES live_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_live_session_chat_session_id ON live_session_chat_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_live_session_chat_session_timestamp ON live_session_chat_messages(session_id, timestamp ASC);
