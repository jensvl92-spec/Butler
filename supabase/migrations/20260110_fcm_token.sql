-- Add fcm_token column to ha_connections for push notifications
-- This stores the Firebase Cloud Messaging token for each connection

ALTER TABLE ha_connections 
ADD COLUMN IF NOT EXISTS fcm_token TEXT;

COMMENT ON COLUMN ha_connections.fcm_token IS 'Firebase Cloud Messaging token for push notifications';
