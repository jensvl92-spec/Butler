
-- Enable the pg_cron extension (if available on the instance)
create extension if not exists pg_cron;

-- Schedule the worker to run every minute
-- Note: Requires Project > Database > Extensions > pg_cron to be enabled in Supabase Dashboard
select cron.schedule(
  'scheduler-worker-job',
  '* * * * *', -- Every minute
  $$
  select
    net.http_post(
        url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/scheduler-worker',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer SERVICE_ROLE_KEY"}'::jsonb
    ) as request_id;
  $$
);
