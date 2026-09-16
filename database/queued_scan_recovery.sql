-- Recover late offline submissions only when every game agrees with the scan.
create or replace function public.cc_submit_queued_result(p_match jsonb,p_games jsonb,p_rallies jsonb)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare previous public.match_log%rowtype; merge_scan boolean:=false;
begin
 perform 1 from public.fixtures where fixture_id=p_match->>'fixture_id' for update;
 select * into previous from public.match_log where fixture_id=p_match->>'fixture_id';
 if previous.source='scan' and p_match->>'source'='app'
  and previous.player1_id=p_match->>'player1_id' and previous.player2_id=p_match->>'player2_id'
  and previous.games_p1=(p_match->>'games_p1')::int and previous.games_p2=(p_match->>'games_p2')::int
  and jsonb_array_length(p_games)>0
  and (select count(*) from public.game_log where match_id=previous.match_id)=jsonb_array_length(p_games)
  and not exists(select 1 from public.game_log g full join jsonb_to_recordset(p_games) as p(game_no int,points_p1 int,points_p2 int,game_winner_id text)
    on p.game_no=g.game_no and g.match_id=previous.match_id
    where (g.match_id=previous.match_id or g.match_id is null) and
     (p.game_no is null or g.game_no is null or g.points_p1 is distinct from p.points_p1 or g.points_p2 is distinct from p.points_p2 or g.game_winner_id is distinct from p.game_winner_id))
 then merge_scan:=true;
 end if;
 return public.cc_save_result(p_match,p_games,p_rallies,merge_scan)||jsonb_build_object('matchedScan',merge_scan);
end $$;
revoke all on function public.cc_submit_queued_result(jsonb,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.cc_submit_queued_result(jsonb,jsonb,jsonb) to service_role;
