-- Apply to the existing Court Card schema. All writes remain service-role only.
create table if not exists public.roster_substitutes (
 comp_ref text not null references public.comps(comp_ref),
 player_id text not null references public.players(player_id),
 line integer not null check (line between 1 and 5),
 primary key(comp_ref,player_id)
);
alter table public.roster_substitutes enable row level security;
revoke all on public.roster_substitutes from public,anon,authenticated;
grant select,insert,update,delete on public.roster_substitutes to service_role;
create index if not exists roster_substitutes_player_idx on public.roster_substitutes(player_id);
create table if not exists court_card_private.roster_archive (
 archive_id bigint generated always as identity primary key,
 archived_at timestamptz not null default now(),
 comp_ref text not null,
 previous_roster jsonb not null,
 previous_substitutes jsonb not null,
 previous_teams jsonb not null,
 previous_unplayed_fixtures jsonb not null
);
alter table court_card_private.roster_archive enable row level security;
revoke all on court_card_private.roster_archive from public,anon,authenticated;
grant select,insert on court_card_private.roster_archive to service_role;
grant usage,select on sequence court_card_private.roster_archive_archive_id_seq to service_role;

create or replace function public.cc_save_roster(p_comp text,p_rows jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare item jsonb; team_no_value integer; line_value integer; player_value text;
 slots text[]:='{}'; people text[]:='{}'; slot text; updated_count integer; frozen_count integer;
begin
 if jsonb_typeof(p_rows) is distinct from 'array' then raise exception 'Roster must be an array';end if;
 perform 1 from public.comps where comp_ref=p_comp for update;
 if not found then raise exception 'Competition % does not exist',p_comp;end if;
 for item in select value from jsonb_array_elements(p_rows) loop
  player_value:=item->>'playerId';
  if player_value is null or not exists(select 1 from public.players where player_id=player_value) then
   raise exception 'Unknown player ID % for %',player_value,item->>'player';end if;
  if player_value=any(people) then raise exception 'Player % [%] appears more than once in the roster or substitute pool',item->>'player',player_value;end if;
  people:=array_append(people,player_value);
  if coalesce(item->>'line','') !~ '^[1-5]$' then raise exception 'Invalid line for %: choose line 1 to 5',item->>'player';end if;
  if item->>'teamNo'='Sub' then continue;end if;
  if coalesce(item->>'teamNo','') !~ '^[1-9][0-9]{0,3}$' then raise exception 'Invalid team for %: choose a numbered team or Sub',item->>'player';end if;
  slot:=(item->>'teamNo')||':'||(item->>'line');
  if slot=any(slots) then raise exception 'Team %, line % has more than one player',item->>'teamNo',item->>'line';end if;
  slots:=array_append(slots,slot);
  if btrim(coalesce(item->>'teamName',''))='' then raise exception 'Missing name for team %',item->>'teamNo';end if;
 end loop;
 -- Lock fixtures in the same order as result operations. Recheck played
 -- after locks so a concurrently committed match cannot be reassigned.
 perform 1 from public.fixtures where comp_ref=p_comp order by fixture_id for update;
 insert into court_card_private.roster_archive(comp_ref,previous_roster,previous_substitutes,previous_teams,previous_unplayed_fixtures)
 values(p_comp,
  coalesce((select jsonb_agg(to_jsonb(r)) from public.roster r where r.comp_ref=p_comp),'[]'),
  coalesce((select jsonb_agg(to_jsonb(s)) from public.roster_substitutes s where s.comp_ref=p_comp),'[]'),
  coalesce((select jsonb_agg(to_jsonb(t)) from public.teams t where t.comp_ref=p_comp),'[]'),
  coalesce((select jsonb_agg(to_jsonb(f)) from public.fixtures f where f.comp_ref=p_comp and not f.played),'[]'));
 for item in select value from jsonb_array_elements(p_rows) loop
  if item->>'teamNo'='Sub' then continue;end if;
  insert into public.teams(comp_ref,team_no,team_name) values(p_comp,(item->>'teamNo')::integer,item->>'teamName')
  on conflict(comp_ref,team_no) do update set team_name=excluded.team_name;
 end loop;
 delete from public.roster where comp_ref=p_comp;
 delete from public.roster_substitutes where comp_ref=p_comp;
 for item in select value from jsonb_array_elements(p_rows) loop
  if item->>'teamNo'='Sub' then
   insert into public.roster_substitutes(comp_ref,player_id,line) values(p_comp,item->>'playerId',(item->>'line')::integer);
  else
   insert into public.roster(comp_ref,team_id,line,player_id,captain)
   select p_comp,t.team_id,(item->>'line')::integer,item->>'playerId',coalesce((item->>'captain')::boolean,false)
   from public.teams t where t.comp_ref=p_comp and t.team_no=(item->>'teamNo')::integer;
  end if;
 end loop;
 with desired as (
  select f.fixture_id,
   (select r.player_id from public.roster r where r.comp_ref=p_comp and r.team_id=f.team1_id and r.line=f.line) as p1,
   (select r.player_id from public.roster r where r.comp_ref=p_comp and r.team_id=f.team2_id and r.line=f.line) as p2
  from public.fixtures f where f.comp_ref=p_comp and not f.played
   and not exists(select 1 from public.match_log m where m.fixture_id=f.fixture_id)
 ) update public.fixtures f set player1_id=d.p1,player2_id=d.p2 from desired d
 where f.fixture_id=d.fixture_id and (f.player1_id is distinct from d.p1 or f.player2_id is distinct from d.p2);
 get diagnostics updated_count=row_count;
 select count(*) into frozen_count from public.fixtures where comp_ref=p_comp and played;
 return jsonb_build_object('ok',true,'count',jsonb_array_length(p_rows),'fixturesUpdated',updated_count,'fixturesFrozen',frozen_count);
end $$;
revoke all on function public.cc_save_roster(text,jsonb) from public,anon,authenticated;
grant execute on function public.cc_save_roster(text,jsonb) to service_role;
