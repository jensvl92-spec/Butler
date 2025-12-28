-- Ensure pg_net is available for http calls
create extension if not exists "pg_net";

-- Schedule the Daily Butler Morning Briefing
-- Runs at 07:00 UTC every day
select cron.schedule(
  'morning-briefing-job',
  '0 7 * * *',
  $$
  select
    net.http_post(
        url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/daily-butler',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer sb_secret_SefL5_Qu2OyV8z9ZlJV6Cw_058l78ij"}'::jsonb,
        body:='{"mode": "morning_briefing"}'::jsonb
    ) as request_id;
  $$
);

-- Optional: Schedule Night Watch at 22:00 UTC (10 PM)
select cron.schedule(
  'night-watch-job',
  '0 22 * * *',
  $$
  select
    net.http_post(
        url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/daily-butler',
        headers:='{"Content-Type": "application/json", "Authorization": "Bearer sb_secret_SefL5_Qu2OyV8z9ZlJV6Cw_058l78ij"}'::jsonb,
        body:='{"mode": "night_watch"}'::jsonb
    ) as request_id;
  $$
);
