-- Energy Scheduling Tables
-- Stores scheduled energy optimization tasks

CREATE TABLE IF NOT EXISTS energy_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id UUID NOT NULL,
  device_entity_id TEXT NOT NULL,
  
  -- Schedule
  start_time TIMESTAMP NOT NULL,
  duration_minutes INT NOT NULL,
  
  -- Price context
  avg_price_scheduled FLOAT,
  avg_price_avoided FLOAT,
  estimated_savings FLOAT,
  price_unit TEXT DEFAULT '€/kWh',
  
  -- Status
  status TEXT DEFAULT 'pending',  -- pending, active, completed, cancelled
  automation_ids TEXT[],  -- HA automation IDs created
  
  created_at TIMESTAMP DEFAULT NOW(),
  completed_at TIMESTAMP
);

-- Index for lookups
CREATE INDEX IF NOT EXISTS idx_energy_schedules_connection 
ON energy_schedules(connection_id, status);

-- Enable RLS
ALTER TABLE energy_schedules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access on energy_schedules" 
ON energy_schedules FOR ALL USING (true) WITH CHECK (true);

COMMENT ON TABLE energy_schedules IS 'Scheduled energy optimization tasks for EV charging, water heating, etc.';
