alter table public.suggestions 
add column if not exists context_key text;

comment on column public.suggestions.context_key is 'Fingerprint of the event context (entity:state:hour) used for suppression logic.';
