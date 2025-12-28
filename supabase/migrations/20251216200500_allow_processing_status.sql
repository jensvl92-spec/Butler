-- Remove the old check constraint
alter table scheduled_actions drop constraint if exists scheduled_actions_status_check;

-- Add the new check constraint including 'processing'
alter table scheduled_actions add constraint scheduled_actions_status_check 
check (status in ('pending', 'processing', 'executed', 'failed'));
