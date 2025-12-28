-- Enable RLS on memories table
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;

-- Policy for Service Role (Full Access)
-- Essential for Edge Functions (process-ai-command) to read/write memories
CREATE POLICY "Service Role has full access to memories"
  ON memories
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Policy for Authenticated Users (Read/Write)
-- Matches pattern of other tables where authenticated users own the data
-- (Note: memories table currently lacks user_id, so this gives access to ALL memories for any auth user. 
--  If this is a multi-user app, you should add user_id to memories table later.)
CREATE POLICY "Authenticated users can view memories"
  ON memories
  FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Authenticated users can insert memories"
  ON memories
  FOR INSERT
  TO authenticated
  WITH CHECK (true);

CREATE POLICY "Authenticated users can update memories"
  ON memories
  FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

CREATE POLICY "Authenticated users can delete memories"
  ON memories
  FOR DELETE
  TO authenticated
  USING (true);
