-- Duplicate player cleanup + guard. Run the numbered steps one at a time in the
-- Supabase SQL editor (Step 1 and 2 are read-only).

-- ===== STEP 1 (read-only): what does the LIVE name-resolver look like? =====
select pg_get_functiondef('public.cc_resolve_player(text,text,text,text)'::regprocedure);

-- ===== STEP 2 (read-only): list the duplicate groups =====
-- Same normalisation cc_resolve_player uses; alias rows are ignored.
select norm, count(*) as copies,
       array_agg(player_id order by (player_id !~ '^P[0-9]+$'), player_id) as ids,
       array_agg('[' || name || ']' order by (player_id !~ '^P[0-9]+$'), player_id) as names_as_stored
from (
  select player_id, name,
         regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g') as norm
  from public.players
  where player_id not in (select alias_id from public.player_aliases)
) n
group by norm having count(*) > 1
order by norm;

-- ===== STEP 3: merge every duplicate group into one player =====
-- Keeps the legacy P#### id when there is one (else the lowest id), re-points EVERY
-- foreign key that references players(player_id) to it, fills any blank
-- email/phone/grade on the kept row from the duplicate, then deletes the duplicate.
-- One DO block = one transaction: any error rolls the whole thing back.
-- Where re-pointing would collide with a row the kept player already has (same
-- roster slot, same arrival...), the duplicate's row is dropped instead; results,
-- games and fixtures are never dropped (a collision there aborts the run).
do $$
declare g record; keep text; dup text; fk record;
begin
 for g in
  select norm, array_agg(player_id order by (player_id !~ '^P[0-9]+$'), player_id) as ids
  from (
    select player_id,
           regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g') as norm
    from public.players
    where player_id not in (select alias_id from public.player_aliases)
  ) n
  group by norm having count(*) > 1
 loop
  keep := g.ids[1];
  foreach dup in array g.ids[2:array_length(g.ids,1)] loop
   for fk in
    select ns.nspname as sch, cl.relname as tbl, a.attname::text as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_namespace ns on ns.oid = cl.relnamespace
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and c.confrelid = 'public.players'::regclass and array_length(c.conkey,1) = 1
   loop
    begin
     execute format('update %I.%I set %I = $1 where %I = $2', fk.sch, fk.tbl, fk.col, fk.col) using keep, dup;
    exception when unique_violation then
     if fk.tbl in ('roster','roster_substitutes','player_arrivals','player_unavailability','fixture_sub_nominations') then
      execute format('delete from %I.%I where %I = $1', fk.sch, fk.tbl, fk.col) using dup;
      raise notice 'collision in %: dropped duplicate''s row for %', fk.tbl, dup;
     else
      raise;
     end if;
    end;
   end loop;
   update public.players k
      set email = coalesce(nullif(k.email,''), d.email),
          phone = coalesce(nullif(k.phone,''), d.phone),
          grade = coalesce(nullif(k.grade,''), d.grade)
     from public.players d
    where k.player_id = keep and d.player_id = dup;
   delete from public.players where player_id = dup;
   raise notice 'merged % into % (%)', dup, keep, g.norm;
  end loop;
 end loop;
end $$;

-- ===== STEP 4: guard - stop ANY code path creating a second copy of a name =====
-- A bad insert now fails loudly (and names the existing id) instead of silently
-- creating a duplicate. Run AFTER step 3.
create or replace function public.cc_block_duplicate_player() returns trigger
language plpgsql set search_path = '' as $$
declare norm text; existing text;
begin
 norm := regexp_replace(regexp_replace(lower(btrim(new.name)),'\s+',' ','g'),'[^a-z0-9 ]','','g');
 select p.player_id into existing from public.players p
  where p.player_id <> new.player_id
    and regexp_replace(regexp_replace(lower(btrim(p.name)),'\s+',' ','g'),'[^a-z0-9 ]','','g') = norm
    and not exists (select 1 from public.player_aliases a where a.alias_id = p.player_id)
  limit 1;
 if existing is not null then
  raise exception 'Player "%" already exists as % - not creating a duplicate', new.name, existing using errcode = '23505';
 end if;
 return new;
end $$;
drop trigger if exists cc_block_duplicate_player on public.players;
create trigger cc_block_duplicate_player before insert or update of name on public.players
 for each row execute function public.cc_block_duplicate_player();
