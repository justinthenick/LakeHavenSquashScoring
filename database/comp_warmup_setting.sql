-- Per-competition warm-up timer shown in the scorer before a match starts.
-- 0 = no countdown (scorer just asks who serves first); otherwise the length in seconds.
-- Default 180 (3 minutes, with the warning at half time).
alter table public.comps add column if not exists warmup_seconds integer not null default 180;
alter table public.comps drop constraint if exists comps_warmup_seconds_check;
alter table public.comps add constraint comps_warmup_seconds_check check (warmup_seconds = 0 or warmup_seconds between 30 and 900);
