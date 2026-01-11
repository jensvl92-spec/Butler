-- Thermal Learning System Tables
-- Stores contextual heating rates for AI-powered heating time predictions

-- Main table: Bucketed heating rates per room and conditions
CREATE TABLE IF NOT EXISTS climate_heating_rates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
  room TEXT NOT NULL,
  
  -- Bucket dimensions
  room_temp_bucket INT NOT NULL,           -- 10-25 (per 1°C)
  room_humidity_bucket TEXT NOT NULL,      -- 'low'|'med'|'high'
  outside_temp_bucket INT NOT NULL,        -- -20 to 24 (per 2°C, even numbers)
  outside_humidity_bucket TEXT NOT NULL,   -- 'low'|'med'|'high'
  
  -- Learned values
  avg_heating_rate FLOAT NOT NULL,         -- °C per minute
  sample_count INT DEFAULT 1,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT NOW(),
  last_updated TIMESTAMP DEFAULT NOW(),
  
  -- Unique constraint on bucket combination
  UNIQUE(connection_id, room, room_temp_bucket, room_humidity_bucket, 
         outside_temp_bucket, outside_humidity_bucket)
);

-- Index for fast lookups by Butler
CREATE INDEX IF NOT EXISTS idx_climate_rates_lookup 
ON climate_heating_rates(connection_id, room, room_temp_bucket, outside_temp_bucket);

-- Room adjacency heat loss factors (optional, for advanced predictions)
CREATE TABLE IF NOT EXISTS room_adjacency_factors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL REFERENCES ha_connections(id) ON DELETE CASCADE,
  room TEXT NOT NULL,
  adjacent_room TEXT NOT NULL,
  
  -- Heat loss multiplier: 1.0 = no effect, 1.2 = 20% slower when adjacent is cold
  heat_loss_factor FLOAT DEFAULT 1.0,
  sample_count INT DEFAULT 1,
  last_updated TIMESTAMP DEFAULT NOW(),
  
  UNIQUE(connection_id, room, adjacent_room)
);

-- Enable RLS
ALTER TABLE climate_heating_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_adjacency_factors ENABLE ROW LEVEL SECURITY;

-- RLS policies (service role can do everything)
CREATE POLICY "Service role full access on climate_heating_rates" 
ON climate_heating_rates FOR ALL 
USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access on room_adjacency_factors" 
ON room_adjacency_factors FOR ALL 
USING (true) WITH CHECK (true);

-- Add comment for documentation
COMMENT ON TABLE climate_heating_rates IS 'Bucketed heating rates for thermal predictions. Updated weekly by learn-climate function.';
COMMENT ON COLUMN climate_heating_rates.avg_heating_rate IS 'Average temperature increase in °C per minute under these conditions';
COMMENT ON COLUMN climate_heating_rates.room_humidity_bucket IS 'low (<40%), med (40-69%), high (≥70%)';
