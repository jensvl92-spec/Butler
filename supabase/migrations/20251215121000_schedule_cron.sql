
select cron.schedule(
  'learn-climate-job',
  '0 3 * * *', -- At 03:00 every day
  $$
  select
    net.http_post(
        url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/learn-climate',
        headers:='{"Content-Type": "application/json"}'::jsonb
    ) as request_id;
  $$
);
