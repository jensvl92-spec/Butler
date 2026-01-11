-- MCP Proxy Database Schema
-- Device inventory synced from Home Assistant
-- Created: 2024-12-29

-- Device inventory table
CREATE TABLE IF NOT EXISTS device_inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  entity_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  state TEXT,
  friendly_name TEXT,
  room TEXT,
  attributes JSONB DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, entity_id)
);

-- MCP Tools table (generated from device inventory + static tools)
CREATE TABLE IF NOT EXISTS mcp_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID,  -- NULL for global tools
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'tool',  -- 'tool' or 'agent'
  category TEXT,
  description TEXT NOT NULL,
  when_to_use TEXT,
  parameters JSONB DEFAULT '[]',
  returns TEXT,
  examples JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(connection_id, name)
);

-- Agents table (specialist agents for delegation)
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'agent',
  description TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  input TEXT,
  output TEXT,
  examples JSONB DEFAULT '[]',
  tags TEXT[] DEFAULT '{}'
);

-- User memories (preferences, aliases, facts)
CREATE TABLE IF NOT EXISTS user_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  text TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Denied automation proposals
CREATE TABLE IF NOT EXISTS denied_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  text TEXT NOT NULL,
  count INT DEFAULT 1,
  reason TEXT,
  last_denied TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Raw sync data for diff comparison (MCP Librarian)
CREATE TABLE IF NOT EXISTS mcp_raw_sync (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL UNIQUE,
  entity_count INT DEFAULT 0,
  service_domains TEXT[] DEFAULT '{}',
  synced_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_device_inventory_connection ON device_inventory(connection_id);
CREATE INDEX IF NOT EXISTS idx_device_inventory_domain ON device_inventory(domain);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_connection ON mcp_tools(connection_id);
CREATE INDEX IF NOT EXISTS idx_mcp_tools_type ON mcp_tools(type);
CREATE INDEX IF NOT EXISTS idx_user_memories_connection ON user_memories(connection_id);
CREATE INDEX IF NOT EXISTS idx_denied_proposals_connection ON denied_proposals(connection_id);

-- Insert default agents
INSERT INTO agents (name, type, description, when_to_use, input, output, examples, tags) VALUES
(
  'personal_assistant',
  'agent',
  'Handles personal life management: calendar, email, weather, music, tasks.',
  'User asks about meetings, emails, weather forecast, playing music, or to-do items.',
  'Natural language request about personal tasks',
  'Response with information or confirmation of action taken',
  '["What''s my next meeting? → Checks calendar, returns meeting details", "Is it going to rain today? → Fetches weather, returns forecast"]',
  ARRAY['calendar', 'email', 'weather', 'music', 'tasks', 'personal']
),
(
  'automation_creator',
  'agent',
  'Creates new Home Assistant automations from user intent.',
  'User wants something to happen automatically, on schedule, or in response to triggers.',
  'Description of desired automation behavior',
  'Generated automation YAML (requires user confirmation)',
  '["Turn on lights at sunset → Creates time-based automation", "Lock door when I leave → Creates zone-based automation"]',
  ARRAY['automation', 'create', 'schedule', 'trigger']
),
(
  'automation_handler',
  'agent',
  'Enables, disables, or manually triggers existing automations.',
  'User wants to control an existing automation''s runtime state.',
  'Automation name and desired action (enable/disable/trigger)',
  'Confirmation of automation state change',
  '["Disable the morning routine → Turns off automation.morning_routine", "Run the goodnight automation now → Triggers automation.goodnight"]',
  ARRAY['automation', 'enable', 'disable', 'trigger', 'toggle']
),
(
  'automation_engineer',
  'agent',
  'Proactively suggests new automations based on observed usage patterns.',
  'System detects repetitive behavior that could be automated.',
  'Pattern analysis results from analyzer agent',
  'Automation proposal (checked against denied proposals first)',
  '["You turn on the coffee machine every weekday at 7am → Propose automation"]',
  ARRAY['automation', 'suggest', 'proactive', 'patterns']
),
(
  'analyzer',
  'agent',
  'Analyzes device history to find patterns, routines, and anomalies.',
  'User asks ''why'' something happens, wants to see patterns, or system needs behavior analysis.',
  'Device history data or user question about patterns',
  'List of detected patterns with confidence scores',
  '["Why is my energy bill high? → Analyzes device usage patterns", "Show me my routines → Identifies recurring behaviors"]',
  ARRAY['analyze', 'patterns', 'history', 'why', 'routines']
),
(
  'proposal_validator',
  'agent',
  'Checks if an automation proposal was previously denied by the user.',
  'Before proposing any automation to the user (prevents nagging).',
  'Proposed automation text',
  'ALLOW, WARN (denied 1-2x), or REJECT (denied 3+ times)',
  '["Check: ''Auto-lock front door at night'' → ALLOW (never denied)", "Check: ''Turn off all lights at 10pm'' → REJECT (denied 3 times)"]',
  ARRAY['validate', 'proposal', 'denied', 'check']
)
ON CONFLICT (name) DO UPDATE SET
  description = EXCLUDED.description,
  when_to_use = EXCLUDED.when_to_use,
  input = EXCLUDED.input,
  output = EXCLUDED.output,
  examples = EXCLUDED.examples,
  tags = EXCLUDED.tags;

-- Insert default tools
INSERT INTO mcp_tools (connection_id, name, type, category, description, when_to_use, parameters, returns, examples) VALUES
(NULL, 'get_lights', 'tool', 'devices', 
  'Returns all light entities with their current state (on/off, brightness).',
  'User mentions lights, lamps, illumination, brightness, or ''it''s dark''.',
  '[{"name": "room", "type": "string", "optional": true, "description": "Filter by room name"}]',
  'Array of {entity_id, state, friendly_name, brightness}',
  '["get_lights() → all lights", "get_lights(room=''kitchen'') → kitchen lights only"]'
),
(NULL, 'get_switches', 'tool', 'devices',
  'Returns all switch entities (plugs, appliances) with their current state.',
  'User mentions switches, plugs, outlets, or appliances.',
  '[{"name": "room", "type": "string", "optional": true, "description": "Filter by room name"}]',
  'Array of {entity_id, state, friendly_name}',
  '["get_switches() → all switches", "get_switches(room=''garage'') → garage switches"]'
),
(NULL, 'get_climate', 'tool', 'devices',
  'Returns climate devices (thermostats, AC, heaters) with temperature and mode.',
  'User mentions temperature, heating, cooling, AC, thermostat, or ''it''s cold/hot''.',
  '[{"name": "room", "type": "string", "optional": true, "description": "Filter by room name"}]',
  'Array of {entity_id, state, current_temp, target_temp, hvac_mode}',
  '["get_climate() → all thermostats", "get_climate(room=''bedroom'') → bedroom climate"]'
),
(NULL, 'get_covers', 'tool', 'devices',
  'Returns cover entities (blinds, garage doors, curtains) with their state.',
  'User mentions blinds, curtains, garage door, covers, or shades.',
  '[{"name": "room", "type": "string", "optional": true, "description": "Filter by room name"}]',
  'Array of {entity_id, state, position}',
  '["get_covers() → all covers", "get_covers(room=''living_room'') → living room blinds"]'
),
(NULL, 'search_devices', 'tool', 'devices',
  'Semantic search for any device by name, description, or function.',
  'User refers to a device by nickname, description, or you cannot find it by type.',
  '[{"name": "query", "type": "string", "required": true, "description": "Search query"}]',
  'Array of matching devices with entity_id, state, friendly_name',
  '["search_devices(query=''coffee'') → finds coffee machine", "search_devices(query=''entrance'') → finds front door devices"]'
),
(NULL, 'execute_ha_service', 'tool', 'actions',
  'Executes a Home Assistant service on one or more entities.',
  'Always use this to control devices after identifying them.',
  '[{"name": "entity_id", "type": "string", "required": true}, {"name": "service", "type": "string", "required": true}, {"name": "data", "type": "object", "optional": true}]',
  'Confirmation of service execution',
  '["execute_ha_service(entity_id=''light.kitchen'', service=''turn_on'')", "execute_ha_service(entity_id=''climate.living'', service=''set_temperature'', data={temperature: 22})"]'
),
(NULL, 'save_memory', 'tool', 'memory',
  'Stores a user preference, alias, or fact for future reference.',
  'User teaches you something: ''remember that...'', ''I prefer...'', ''call X as Y''.',
  '[{"name": "text", "type": "string", "required": true, "description": "The fact to remember"}]',
  'Confirmation that memory was saved',
  '["save_memory(text=''The guest room is called the Dungeon'')", "save_memory(text=''User prefers lights dim for movies'')"]'
),
(NULL, 'search_memory', 'tool', 'memory',
  'Retrieves stored user preferences and facts relevant to a query.',
  'Need context about user preferences, aliases, or past instructions.',
  '[{"name": "query", "type": "string", "required": true, "description": "What to search for"}]',
  'List of relevant memories',
  '["search_memory(query=''dungeon'') → ''The guest room is called the Dungeon''", "search_memory(query=''movie preferences'')"]'
),
(NULL, 'get_automations', 'tool', 'automation',
  'Returns all Home Assistant automations with their enabled/disabled state.',
  'User asks about automations, schedules, or routines.',
  '[{"name": "filter", "type": "string", "optional": true, "description": "Filter by name"}]',
  'Array of {entity_id, state (on/off), friendly_name}',
  '["get_automations() → all automations", "get_automations(filter=''morning'') → morning automations"]'
)
ON CONFLICT (connection_id, name) DO UPDATE SET
  description = EXCLUDED.description,
  when_to_use = EXCLUDED.when_to_use,
  parameters = EXCLUDED.parameters,
  returns = EXCLUDED.returns,
  examples = EXCLUDED.examples;
