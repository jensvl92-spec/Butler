-- Enable required extensions
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1. Morning Briefing (7:00 AM)
select cron.schedule(
  'morning_briefing',
  '0 7 * * *',
  $$
  select net.http_post(
      url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/daily-butler',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTIyNjcwOCwiZXhwIjoyMDgwODAyNzA4fQ.EYaVCgea0pAmNPt1mnyom_isbJXytsfqxqxeLFOyRRU"}'::jsonb,
      body:='{"mode": "morning_briefing"}'::jsonb
  ) as request_id;
  $$
);

-- 2. Night Watch (10:00 PM)
select cron.schedule(
  'night_watch',
  '0 22 * * *',
  $$
  select net.http_post(
      url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/daily-butler',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTIyNjcwOCwiZXhwIjoyMDgwODAyNzA4fQ.EYaVCgea0pAmNPt1mnyom_isbJXytsfqxqxeLFOyRRU"}'::jsonb,
      body:='{"mode": "night_watch"}'::jsonb
  ) as request_id;
  $$
);

-- 3. Weekly Consultant (Sundays 8:00 AM)
select cron.schedule(
  'weekly_consultant',
  '0 8 * * 0',
  $$
  select net.http_post(
      url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/analyze-patterns',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTIyNjcwOCwiZXhwIjoyMDgwODAyNzA4fQ.EYaVCgea0pAmNPt1mnyom_isbJXytsfqxqxeLFOyRRU"}'::jsonb
  ) as request_id;
  $$
);

-- 4. [NEW] Scheduler Worker (Every Minute)
-- REQUIRED for "Delayed Actions" (Turn off in 30s)
select cron.schedule(
  'scheduler_worker',
  '* * * * *',
  $$
  select net.http_post(
      url:='https://rbriqijzyptjwsjrsqvc.supabase.co/functions/v1/scheduler-worker',
      headers:='{"Content-Type": "application/json", "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJicmlxaWp6eXB0andzanJzcXZjIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2NTIyNjcwOCwiZXhwIjoyMDgwODAyNzA4fQ.EYaVCgea0pAmNPt1mnyom_isbJXytsfqxqxeLFOyRRU"}'::jsonb
  ) as request_id;
  $$
);
