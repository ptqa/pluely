-- Add an AI-generated meeting summary to Live Suggest sessions. Generated on
-- demand from the session history view and persisted so it isn't regenerated
-- on every visit (the user can still regenerate it).
ALTER TABLE live_sessions ADD COLUMN summary TEXT;
