/*
  # Initialize Home Assistant AI App Schema

  1. New Tables
    - `ha_connections`: Store Home Assistant instance connections
      - `id` (uuid, primary key)
      - `user_id` (uuid, auth reference)
      - `name` (text) - friendly name for the connection
      - `api_url` (text) - Home Assistant URL
      - `api_token` (text) - encrypted token (stored via Supabase)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `rooms`: Editable rooms/zones in Home Assistant
      - `id` (uuid, primary key)
      - `connection_id` (uuid, foreign key to ha_connections)
      - `name` (text) - room name
      - `description` (text)
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

    - `chat_history`: Store conversation history
      - `id` (uuid, primary key)
      - `connection_id` (uuid, foreign key to ha_connections)
      - `user_message` (text) - user's voice/message input
      - `ai_response` (text) - AI's response with actions
      - `language` (text) - detected language
      - `actions_taken` (jsonb) - array of actions executed
      - `created_at` (timestamp)

    - `user_settings`: App preferences
      - `id` (uuid, primary key)
      - `user_id` (uuid, auth reference)
      - `preferred_language` (text) - for LLM responses
      - `theme` (text) - light/dark
      - `created_at` (timestamp)
      - `updated_at` (timestamp)

  2. Security
    - Enable RLS on all tables
    - Users can only access their own connections, rooms, and settings
    - Implement proper ownership checks via user_id

  3. Indexes
    - Add indexes on foreign keys and user_id for query performance
*/

CREATE TABLE IF NOT EXISTS ha_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL,
  api_url text NOT NULL,
  api_token text NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text DEFAULT '',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS chat_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
  user_message text NOT NULL,
  ai_response text NOT NULL,
  language text DEFAULT 'en',
  actions_taken jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  preferred_language text DEFAULT 'en',
  theme text DEFAULT 'light',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE ha_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE rooms ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own connections"
  ON ha_connections FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create connections"
  ON ha_connections FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own connections"
  ON ha_connections FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own connections"
  ON ha_connections FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can view rooms for their connections"
  ON rooms FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = rooms.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create rooms for their connections"
  ON rooms FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = rooms.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can update rooms for their connections"
  ON rooms FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = rooms.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = rooms.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can delete rooms for their connections"
  ON rooms FOR DELETE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = rooms.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can view chat history for their connections"
  ON chat_history FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = chat_history.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can create chat history for their connections"
  ON chat_history FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM ha_connections
      WHERE ha_connections.id = chat_history.connection_id
      AND ha_connections.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can view own settings"
  ON user_settings FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can create own settings"
  ON user_settings FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own settings"
  ON user_settings FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_ha_connections_user_id ON ha_connections(user_id);
CREATE INDEX idx_rooms_connection_id ON rooms(connection_id);
CREATE INDEX idx_chat_history_connection_id ON chat_history(connection_id);
CREATE INDEX idx_user_settings_user_id ON user_settings(user_id);
