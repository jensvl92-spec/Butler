-- Add connection_id to suggestions for multi-user support
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'connection_id'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN connection_id UUID REFERENCES ha_connections(id);
  END IF;
  
  -- Add trigger type for automation suggestions
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'trigger'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN trigger TEXT;
  END IF;
  
  -- Add condition for automation suggestions
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'condition'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN condition TEXT;
  END IF;
  
  -- Add reasoning explaining why this automation is suggested
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'reasoning'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN reasoning TEXT;
  END IF;
  
  -- Add ha_automation config (full HA automation YAML as JSON)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'ha_automation'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN ha_automation JSONB;
  END IF;
  
  -- Add type column if missing
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'suggestions' AND column_name = 'type'
  ) THEN
    ALTER TABLE suggestions ADD COLUMN type TEXT DEFAULT 'automation_proposal';
  END IF;
END $$;

-- Create index for faster lookups by connection and status
CREATE INDEX IF NOT EXISTS idx_suggestions_connection_status 
ON suggestions(connection_id, status);
