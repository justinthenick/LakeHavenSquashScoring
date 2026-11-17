-- Admin "Merge players" tool support. Run this whole file once in the Supabase SQL editor.
-- Both functions are service-role only (the Apps Script backend calls them; browsers cannot).
--
-- cc_player_merge_refs()          : every column that holds a player id (real foreign keys to
--                                   players(player_id) PLUS un-constrained id columns such as
--                                   winner_id / game_winner_id / rally_winner_id).
-- cc_player_merge_preview(k,d)    : read-only. How many rows would move, per table.
-- cc_player_merge(k,d,delete_dup) : moves everything from duplicate d to preferred k.
--     delete_dup=false (default)  : d is kept as an INACTIVE alias of k (row in player_aliases).
--                                   Hidden from every list, old scorer ids/queued results still
--                                   resolve to k. Recommended.
--     delete_dup=true             : d is removed entirely.
-- One call = one transaction; any error rolls everything back.

create or replace function public.cc_player_merge_refs()
returns table(sch text, tbl text, col text)
language sql stable security invoker set search_path='' as $$
  select distinct ns.nspname::text, cl.relname::text, a.attname::text
  from pg_constraint c
  join pg_class cl on cl.oid=c.conrelid
  join pg_namespace ns on ns.oid=cl.relnamespace
  join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
  where c.contype='f' and c.confrelid='public.players'::regclass and array_length(c.conkey,1)=1
    and cl.relname<>'player_aliases'
  union
  select c.table_schema::text, c.table_name::text, c.column_name::text
  from information_schema.columns c
  join information_schema.tables t on t.table_schema=c.table_schema and t.table_name=c.table_name and t.table_type='BASE TABLE'
  where c.table_schema='public'
    and c.data_type in ('text','character varying')
    and c.column_name ~ '^(player[12]?|winner|game_winner|rally_winner|original_player|sub_player)_id$'
    and c.table_name not in ('players','player_aliases')
$$;

create or replace function public.cc_player_merge_preview(p_keep text,p_dup text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r record; n bigint; out jsonb:='[]'::jsonb; kp public.players%rowtype; dp public.players%rowtype;
begin
 select * into kp from public.players where player_id=p_keep; if not found then raise exception 'Preferred player % not found',p_keep using errcode='22023';end if;
 select * into dp from public.players where player_id=p_dup;  if not found then raise exception 'Duplicate player % not found',p_dup using errcode='22023';end if;
 if p_keep=p_dup then raise exception 'Choose two different players' using errcode='22023';end if;
 if exists(select 1 from public.player_aliases where alias_id=p_keep) then raise exception 'Preferred player % is itself an inactive alias; pick the active one',p_keep using errcode='22023';end if;
 for r in select * from public.cc_player_merge_refs() loop
  execute format('select count(*) from %I.%I where %I=$1',r.sch,r.tbl,r.col) into n using p_dup;
  if n>0 then out:=out||jsonb_build_object('table',r.tbl,'column',r.col,'rows',n);end if;
 end loop;
 select count(*) into n from public.player_aliases where player_id=p_dup;
 if n>0 then out:=out||jsonb_build_object('table','player_aliases','column','player_id','rows',n);end if;
 return jsonb_build_object('ok',true,
  'keep',jsonb_build_object('id',kp.player_id,'name',kp.name,'email',kp.email,'phone',kp.phone,'grade',kp.grade),
  'dup',jsonb_build_object('id',dp.player_id,'name',dp.name,'email',dp.email,'phone',dp.phone,'grade',dp.grade),
  'moves',out);
end $$;

create or replace function public.cc_player_merge(p_keep text,p_dup text,p_delete_dup boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare r record; n bigint; moved jsonb:='[]'::jsonb; dropped jsonb:='[]'::jsonb; kp public.players%rowtype; dp public.players%rowtype;
begin
 select * into kp from public.players where player_id=p_keep; if not found then raise exception 'Preferred player % not found',p_keep using errcode='22023';end if;
 select * into dp from public.players where player_id=p_dup;  if not found then raise exception 'Duplicate player % not found',p_dup using errcode='22023';end if;
 if p_keep=p_dup then raise exception 'Choose two different players' using errcode='22023';end if;
 if exists(select 1 from public.player_aliases where alias_id=p_keep) then raise exception 'Preferred player % is itself an inactive alias; pick the active one',p_keep using errcode='22023';end if;
 perform pg_advisory_xact_lock(hashtextextended('court-card-player-merge',0));

 for r in select * from public.cc_player_merge_refs() loop
  begin
   execute format('update %I.%I set %I=$1 where %I=$2',r.sch,r.tbl,r.col,r.col) using p_keep,p_dup;
   get diagnostics n = row_count;
   if n>0 then moved:=moved||jsonb_build_object('table',r.tbl,'rows',n);end if;
  exception when unique_violation then
   -- the preferred player already has the equivalent row (same roster slot, same arrival...)
   if r.tbl in ('roster','roster_substitutes','player_arrivals','player_unavailability','fixture_sub_nominations') then
    execute format('delete from %I.%I where %I=$1',r.sch,r.tbl,r.col) using p_dup;
    get diagnostics n = row_count;
    dropped:=dropped||jsonb_build_object('table',r.tbl,'rows',n);
   else
    raise;   -- results, games, fixtures are never dropped
   end if;
  end;
 end loop;

 -- aliases that already pointed at the duplicate now point at the preferred player
 update public.player_aliases set player_id=p_keep where player_id=p_dup;

 -- fill blanks on the preferred record from the duplicate
 update public.players k set email=coalesce(nullif(k.email,''),d.email),phone=coalesce(nullif(k.phone,''),d.phone),grade=coalesce(nullif(k.grade,''),d.grade)
  from public.players d where k.player_id=p_keep and d.player_id=p_dup;

 if p_delete_dup then
  delete from public.player_aliases where alias_id=p_dup;
  delete from public.players where player_id=p_dup;
 else
  insert into public.player_aliases(alias_id,player_id) values(p_dup,p_keep) on conflict (alias_id) do update set player_id=excluded.player_id;
 end if;
 return jsonb_build_object('ok',true,'keep',p_keep,'dup',p_dup,'mode',case when p_delete_dup then 'deleted' else 'inactive' end,'moved',moved,'dropped',dropped);
end $$;

revoke all on function public.cc_player_merge_refs() from public,anon,authenticated;
revoke all on function public.cc_player_merge_preview(text,text) from public,anon,authenticated;
revoke all on function public.cc_player_merge(text,text,boolean) from public,anon,authenticated;
grant execute on function public.cc_player_merge_refs() to service_role;
grant execute on function public.cc_player_merge_preview(text,text) to service_role;
grant execute on function public.cc_player_merge(text,text,boolean) to service_role;

-- Sanity check after running (read-only): lists every column the merge will re-point.
-- select * from public.cc_player_merge_refs() order by 2,3;
