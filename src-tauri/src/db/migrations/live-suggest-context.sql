-- Add per-session background context to Live Suggest sessions.
-- Stored as a JSON array of context items (typed notes, text files, images)
-- that are injected into suggestion generation and restored on resume.
ALTER TABLE live_sessions ADD COLUMN context TEXT;
