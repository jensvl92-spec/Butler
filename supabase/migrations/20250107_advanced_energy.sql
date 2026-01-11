-- Advanced Energy Features Migration

-- Table to store learned charging characteristics for devices (e.g. EVs)
CREATE TABLE IF NOT EXISTS charging_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
  device_entity_id TEXT NOT NULL,
  
  -- Learned Parameters
  battery_capacity_kwh FLOAT DEFAULT 75.0,  -- Total capacity estimate
  avg_charging_speed_kw FLOAT DEFAULT 11.0, -- Learned real-world charging speed
  sample_count INT DEFAULT 0,               -- Number of sessions analyzed
  
  last_updated TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(connection_id, device_entity_id)
);

-- Update energy_schedules to support advanced features
ALTER TABLE energy_schedules 
ADD COLUMN IF NOT EXISTS target_percent INT,            -- e.g. 80%
ADD COLUMN IF NOT EXISTS battery_entity_id TEXT,        -- sensor.tesla_battery_level
ADD COLUMN IF NOT EXISTS source_type TEXT DEFAULT 'grid'; -- 'grid' or 'solar'

-- RLS
ALTER TABLE charging_params ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on charging_params" 
ON charging_params FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE charging_params IS 'Learned characteristics for rechargeable devices (EVs, batteries).';
