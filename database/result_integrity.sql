-- Service-only transactional result operations. No anonymous/authenticated execution.
create schema if not exists court_card_private;
revoke all on schema court_card_private from public, anon, authenticated;
grant usage on schema court_card_private to service_role;
create table if not exists court_card_private.result_archive (
 archive_id bigint generated always as identity primary key,
 archived_at timestamptz not null default now(),
 reason text not null, fixture_id text not null, snapshot jsonb not null
);
alter table court_card_private.result_archive enable row level security;
grant select,insert on court_card_private.result_archive to service_role;
grant usage,select on all sequences in schema court_card_private to service_role;

create unique index if not exists match_log_one_result_per_fixture on public.match_log(fixture_id);
create index if not exists fixtures_player1_idx on public.fixtures(player1_id);
create index if not exists fixtures_player2_idx on public.fixtures(player2_id);
create index if not exists fixtures_team1_idx on public.fixtures(team1_id);
create index if not exists fixtures_team2_idx on public.fixtures(team2_id);
create index if not exists game_log_winner_idx on public.game_log(game_winner_id);
create index if not exists match_log_winner_idx on public.match_log(winner_id);
create index if not exists rally_log_winner_idx on public.rally_log(rally_winner_id);
create index if not exists rally_log_server_idx on public.rally_log(server_player_id);
create index if not exists roster_team_idx on public.roster(team_id);

create or replace function public.cc_save_result(p_match jsonb,p_games jsonb,p_rallies jsonb,p_replace boolean default false)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare
 f public.fixtures%rowtype; c public.comps%rowtype; old public.match_log%rowtype;
 m public.match_log%rowtype; gm public.game_log%rowtype; rl public.rally_log%rowtype;
 j jsonb; wins1 int:=0; wins2 int:=0; needed int; num int:=0; hi int; lo int;
 expected_winner text; same_result boolean:=false; is_walkover boolean;
begin
 if jsonb_typeof(p_games)<>'array' or jsonb_typeof(p_rallies)<>'array' then raise exception 'Game and rally arrays are required' using errcode='22023'; end if;
 m:=jsonb_populate_record(null::public.match_log,p_match);
 if m.match_id is null or length(m.match_id)>180 or m.fixture_id is null then raise exception 'Match and fixture IDs are required' using errcode='22023'; end if;
 select * into f from public.fixtures where fixture_id=m.fixture_id for update;
 if not found then raise exception 'Select a valid fixture before saving' using errcode='22023'; end if;
 select * into c from public.comps where comp_ref=f.comp_ref;
 needed:=c.best_of/2+1;
 if m.source not in ('app','scan') or m.source is null then raise exception 'Invalid result source' using errcode='22023'; end if;
 if m.source='app' and (m.player1_id is null or m.player2_id is null or m.player1_id=m.player2_id) then raise exception 'Select two different registered players' using errcode='22023'; end if;
 if m.player1_id=m.player2_id then raise exception 'Players must be different' using errcode='22023'; end if;
 if coalesce(m.duration_sec,0)<0 or jsonb_array_length(p_games)>c.best_of or jsonb_array_length(p_rallies)>10000 then raise exception 'Invalid result size or duration' using errcode='22023'; end if;
 is_walkover:=m.source='scan' and jsonb_array_length(p_games)=0 and coalesce(m.score_line,'')~'\((walkover|scratched)\)';
 for j in select value from jsonb_array_elements(p_games) loop
  gm:=jsonb_populate_record(null::public.game_log,j);num:=num+1;
  if gm.game_no is distinct from num or gm.points_p1 is null or gm.points_p2 is null or least(gm.points_p1,gm.points_p2)<0 or greatest(gm.points_p1,gm.points_p2)>500 then raise exception 'Invalid game scores or ordering' using errcode='22023'; end if;
  if wins1>=needed or wins2>=needed then raise exception 'Extra games after match ended' using errcode='22023'; end if;
  hi:=greatest(gm.points_p1,gm.points_p2);lo:=least(gm.points_p1,gm.points_p2);
  if (not c.win_by_two and (hi<>c.points_per_game or lo>=hi)) or (c.win_by_two and not ((hi=c.points_per_game and hi-lo>=2) or (hi>c.points_per_game and hi-lo=2))) then raise exception 'Game does not satisfy competition scoring rules' using errcode='22023'; end if;
  if gm.points_p1>gm.points_p2 then wins1:=wins1+1;expected_winner:=m.player1_id;else wins2:=wins2+1;expected_winner:=m.player2_id;end if;
  if gm.game_winner_id is distinct from expected_winner then raise exception 'Game winner does not match scores' using errcode='22023'; end if;
 end loop;
 if is_walkover then
  if not ((m.games_p1=needed and m.games_p2=0) or (m.games_p2=needed and m.games_p1=0) or (m.games_p1=0 and m.games_p2=0 and m.score_line like '%(scratched)%')) then raise exception 'Invalid walkover' using errcode='22023'; end if;
 else
  if greatest(wins1,wins2)<>needed or m.games_p1 is distinct from wins1 or m.games_p2 is distinct from wins2 then raise exception 'Incomplete match or inconsistent games won' using errcode='22023'; end if;
 end if;
 expected_winner:=case when m.games_p1>m.games_p2 then m.player1_id when m.games_p2>m.games_p1 then m.player2_id else null end;
 if m.winner_id is distinct from expected_winner then raise exception 'Match winner does not match scores' using errcode='22023'; end if;
 select * into old from public.match_log where fixture_id=f.fixture_id;
 if old.match_id is not null and p_replace and old.source='app' and m.source='scan' and not coalesce((p_match->>'override_app')::boolean,false) then raise exception 'An app result now exists. Reload and explicitly approve its replacement.' using errcode='23505';end if;
 if found and not p_replace then
  if old.match_id<>m.match_id then raise exception 'This fixture already has a result. Ask an administrator to review it.' using errcode='23505'; end if;
  if old.player1_id is distinct from m.player1_id or old.player2_id is distinct from m.player2_id or old.games_p1<>m.games_p1 or old.games_p2<>m.games_p2 or old.winner_id is distinct from m.winner_id or coalesce(old.raw_rally_history,'')<>coalesce(m.raw_rally_history,'') then raise exception 'Saved result differs from this attempt. Ask an administrator to correct it.' using errcode='23505'; end if;
  if exists(select 1 from public.game_log g left join jsonb_to_recordset(p_games) as p(game_no int,points_p1 int,points_p2 int,game_winner_id text) on p.game_no=g.game_no where g.match_id=m.match_id and (p.game_no is null or g.points_p1<>p.points_p1 or g.points_p2<>p.points_p2 or g.game_winner_id is distinct from p.game_winner_id)) then raise exception 'Saved games differ from this attempt' using errcode='23505'; end if;
  same_result:=true;
 end if;
 if old.match_id is not null then
  insert into court_card_private.result_archive(reason,fixture_id,snapshot)
  select case when p_replace then 'replace' else 'idempotent retry or repair' end,f.fixture_id,
   jsonb_build_object('match',to_jsonb(old),'games',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.game_log g where match_id=old.match_id),'rallies',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.rally_log r where match_id=old.match_id));
  delete from public.rally_log where match_id=old.match_id;
  delete from public.game_log where match_id=old.match_id;
  delete from public.match_log where match_id=old.match_id;
 end if;
 insert into public.match_log(match_id,fixture_id,comp_ref,match_date,committed_ts,player1_id,player2_id,sub1,sub2,games_p1,games_p2,winner_id,score_line,duration_sec,scan_link,source,raw_rally_history)
 values(m.match_id,f.fixture_id,f.comp_ref,coalesce(f.scheduled,m.match_date),coalesce(old.committed_ts,now()),m.player1_id,m.player2_id,coalesce(m.sub1,false),coalesce(m.sub2,false),m.games_p1,m.games_p2,m.winner_id,m.score_line,coalesce(m.duration_sec,0),coalesce(nullif(m.scan_link,''),old.scan_link,''),m.source,coalesce(m.raw_rally_history,''));
 for j in select value from jsonb_array_elements(p_games) loop
  gm:=jsonb_populate_record(null::public.game_log,j);
  insert into public.game_log(match_id,game_no,points_p1,points_p2,game_winner_id,time_start,time_end,duration,break_time,scorer,ref,committed_datetime,scan_link)
  values(m.match_id,gm.game_no,gm.points_p1,gm.points_p2,gm.game_winner_id,gm.time_start,gm.time_end,gm.duration,gm.break_time,gm.scorer,gm.ref,now(),coalesce(gm.scan_link,old.scan_link,''));
 end loop;
 for j in select value from jsonb_array_elements(p_rallies) loop
  rl:=jsonb_populate_record(null::public.rally_log,j);
  if rl.game_no<1 or rl.rally_no<1 or rl.p1_score<0 or rl.p2_score<0 or rl.box not in ('R','L') or rl.server_player_id not in (m.player1_id,m.player2_id) or rl.rally_winner_id not in (m.player1_id,m.player2_id) then raise exception 'Invalid rally' using errcode='22023';end if;
  insert into public.rally_log(match_id,fixture_id,rally_date,game_no,rally_no,server_player_id,box,p1_score,p2_score,rally_winner_id)
  values(m.match_id,f.fixture_id,coalesce(f.scheduled,m.match_date),rl.game_no,rl.rally_no,rl.server_player_id,rl.box,rl.p1_score,rl.p2_score,rl.rally_winner_id);
 end loop;
 update public.fixtures set played=true where fixture_id=f.fixture_id;
 return jsonb_build_object('ok',true,'matchId',m.match_id,'duplicate',same_result);
end $$;
revoke all on function public.cc_save_result(jsonb,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.cc_save_result(jsonb,jsonb,jsonb,boolean) to service_role;

create or replace function public.cc_delete_results(p_match_ids text[])
returns jsonb language plpgsql security invoker set search_path='' as $$
declare m public.match_log%rowtype; n int:=0; rows_deleted int:=0; fids text[];
begin
 select array_agg(distinct fixture_id) into fids from public.match_log where match_id=any(p_match_ids);
 perform 1 from public.fixtures where fixture_id=any(fids) order by fixture_id for update;
 for m in select * from public.match_log where match_id=any(p_match_ids) loop
  insert into court_card_private.result_archive(reason,fixture_id,snapshot)
  select 'administrator removal',m.fixture_id,jsonb_build_object('match',to_jsonb(m),'games',(select coalesce(jsonb_agg(to_jsonb(g)),'[]') from public.game_log g where match_id=m.match_id),'rallies',(select coalesce(jsonb_agg(to_jsonb(r)),'[]') from public.rally_log r where match_id=m.match_id));
  rows_deleted:=rows_deleted+1+(select count(*) from public.game_log where match_id=m.match_id)+(select count(*) from public.rally_log where match_id=m.match_id);
  delete from public.rally_log where match_id=m.match_id;
  delete from public.game_log where match_id=m.match_id;
  delete from public.match_log where match_id=m.match_id;n:=n+1;
 end loop;
 update public.fixtures f set played=exists(select 1 from public.match_log ml where ml.fixture_id=f.fixture_id) where f.fixture_id=any(fids);
 return jsonb_build_object('ok',true,'matches',n,'deletedRows',rows_deleted);
end $$;
revoke all on function public.cc_delete_results(text[]) from public,anon,authenticated;
grant execute on function public.cc_delete_results(text[]) to service_role;

create or replace function public.cc_resolve_player(p_name text,p_email text default null,p_phone text default null,p_grade text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare nm text:=btrim(p_name); norm text; p public.players%rowtype; hits int; new_id text;
begin
 if nm is null or length(nm)<2 or length(nm)>150 then raise exception 'Player name must contain 2 to 150 characters' using errcode='22023';end if;
 norm:=regexp_replace(regexp_replace(lower(nm),'\s+',' ','g'),'[^a-z0-9 ]','','g');
 perform pg_advisory_xact_lock(hashtextextended('court-card-player:'||norm,0));
 select count(*) into hits from public.players where regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g')=norm;
 if hits>1 then raise exception 'Ambiguous player name; administrator must resolve duplicate identities' using errcode='22023';end if;
 select * into p from public.players where regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g')=norm;
 if found then
  update public.players set email=coalesce(p_email,email),phone=coalesce(p_phone,phone),grade=coalesce(p_grade,grade) where player_id=p.player_id;
  return jsonb_build_object('ok',true,'name',p.name,'playerId',p.player_id,'added',false);
 end if;
 new_id:='P-'||gen_random_uuid()::text;
 insert into public.players(player_id,name,email,phone,grade) values(new_id,nm,coalesce(p_email,''),coalesce(p_phone,''),coalesce(p_grade,''));
 return jsonb_build_object('ok',true,'name',nm,'playerId',new_id,'added',true);
end $$;
revoke all on function public.cc_resolve_player(text,text,text,text) from public,anon,authenticated;
grant execute on function public.cc_resolve_player(text,text,text,text) to service_role;
