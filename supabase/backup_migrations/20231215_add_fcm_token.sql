-- Add FCM Token column to connections to know where to send push notifications
alter table public.ha_connections 
add column fcm_token text;

-- Security: Allow users to update their own connection's token (assuming RLS allows update)
-- If not, ensure the update policy allows it.
