-- Remove the duplicate/CLI-generated jobs
-- (Keeping the ones we just manually created: morning_briefing, night_watch)

select cron.unschedule('morning-briefing-job');
select cron.unschedule('night-watch-job');

-- Verify what remains
select * from cron.job;
