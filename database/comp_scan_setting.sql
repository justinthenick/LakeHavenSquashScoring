-- Per-competition rule: does this comp confirm app scores against paper score-sheet scans?
-- true  (default) = scans are required to finalise a round (current behaviour)
-- false           = no paper/scans; results are entered manually in Comp Admin
alter table public.comps add column if not exists scan_required boolean not null default true;
