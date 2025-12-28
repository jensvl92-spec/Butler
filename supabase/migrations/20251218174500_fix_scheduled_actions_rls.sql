-- Fix RLS for scheduled_actions
-- Allows users to manage their own scheduled tasks
-- Relies on the link: scheduled_actions.connection_id -> ha_connections.id -> user_id

CREATE POLICY "Users can view own scheduled actions"
  ON scheduled_actions
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = scheduled_actions.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete/cancel own scheduled actions"
  ON scheduled_actions
  FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = scheduled_actions.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

-- Note: Updates usually handled by System/Worker, but users might need to edit? 
-- Enabling update just in case.
CREATE POLICY "Users can update own scheduled actions"
  ON scheduled_actions
  FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = scheduled_actions.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = scheduled_actions.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );
