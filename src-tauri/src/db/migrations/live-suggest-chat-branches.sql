-- Allow saved Live Suggest chat messages to branch when a user edits an older
-- prompt. Messages with the same parent are alternate versions of that turn.
ALTER TABLE live_session_chat_messages ADD COLUMN parent_id TEXT;

CREATE INDEX IF NOT EXISTS idx_live_session_chat_parent_id ON live_session_chat_messages(session_id, parent_id, timestamp ASC);
