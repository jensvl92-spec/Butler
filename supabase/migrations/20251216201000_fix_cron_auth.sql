-- Fix the Scheduler Cron Job Authentication
-- We retrieved the Service Role Key via secure debug function.
-- This migration updates the cron job to use the correct key.

-- 1. Unschedule the old broken job
select cron.unschedule('scheduler-worker-job');

-- 2. Schedule the new working job with the correct authorization
select cron.schedule(
  'scheduler-worker-job',
  '* * * * *', -- Runs every minute
  $$
  select
    net.http_post(
        url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/scheduler-worker',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer sb_secret_SefL5_Qu2OyV8z9ZlJV6Cw_058l78ij"}'::jsonb
    ) as request_id;
  $$
);
