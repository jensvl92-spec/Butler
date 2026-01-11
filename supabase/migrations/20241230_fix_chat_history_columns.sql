-- Add metadata column to chat_history if it doesn't exist
ALTER TABLE chat_history
ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Also ensure actions_taken is present (just in case)
ALTER TABLE chat_history
ADD COLUMN IF NOT EXISTS actions_taken JSONB DEFAULT '[]';

-- And make sure ai_response is JSONB
-- (It might be text if created by very old migration, but let's assume it's okay or compatible)
