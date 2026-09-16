begin;
set local role service_role;
do $$
declare comp text; original_rows jsonb; moved_rows jsonb; bad_rows jsonb; chosen jsonb; result jsonb;
 roster_before jsonb; fixtures_before jsonb; teams_before jsonb; subs_before jsonb;
begin
 select comp_ref into comp from public.roster group by comp_ref having count(*)>1 order by comp_ref limit 1;
 if comp is null then raise exception 'Test requires an existing populated competition';end if;
 select jsonb_agg(jsonb_build_object('player',p.name,'playerId',r.player_id,'teamNo',t.team_no,'teamName',t.team_name,'line',r.line,'captain',r.captain) order by r.roster_id)
 into original_rows from public.roster r join public.teams t using(team_id) join public.players p using(player_id) where r.comp_ref=comp;
 select coalesce(jsonb_agg(jsonb_build_object('player',p.name,'playerId',s.player_id,'teamNo','Sub','teamName','','line',s.line,'captain',false) order by s.player_id),'[]')
 into subs_before from public.roster_substitutes s join public.players p using(player_id) where s.comp_ref=comp;
 original_rows:=original_rows||subs_before;
 chosen:=original_rows->0;
 select jsonb_agg(to_jsonb(f) order by fixture_id) into fixtures_before from public.fixtures f where comp_ref=comp and played;
 moved_rows:=jsonb_set(original_rows,'{0,teamNo}','"Sub"');
 result:=public.cc_save_roster(comp,moved_rows);
 if not (result->>'ok')::boolean then raise exception 'Save failed';end if;
 if not exists(select 1 from public.roster_substitutes where comp_ref=comp and player_id=chosen->>'playerId') then raise exception 'Substitute was not retained';end if;
 if exists(select 1 from public.roster where comp_ref=comp and player_id=chosen->>'playerId') then raise exception 'Substitute remains rostered';end if;
 if (select jsonb_agg(to_jsonb(f) order by fixture_id) from public.fixtures f where comp_ref=comp and played) is distinct from fixtures_before then raise exception 'Played fixtures changed';end if;
 select jsonb_agg(to_jsonb(r) order by roster_id) into roster_before from public.roster r where comp_ref=comp;
 select jsonb_agg(to_jsonb(t) order by team_id) into teams_before from public.teams t where comp_ref=comp;
 select jsonb_agg(to_jsonb(s) order by player_id) into subs_before from public.roster_substitutes s where comp_ref=comp;
 -- Force a late insert failure after the function's delete steps. Its
 -- transaction must preserve the previously committed roster and pool.
 bad_rows:=jsonb_set(original_rows,'{0,captain}','"not-a-boolean"');
 begin
  perform public.cc_save_roster(comp,bad_rows);
  raise exception 'Expected invalid captain failure';
 exception when invalid_text_representation then null;end;
 if (select jsonb_agg(to_jsonb(r) order by roster_id) from public.roster r where comp_ref=comp) is distinct from roster_before then raise exception 'Failed save changed roster';end if;
 if (select jsonb_agg(to_jsonb(t) order by team_id) from public.teams t where comp_ref=comp) is distinct from teams_before then raise exception 'Failed save changed teams';end if;
 if (select jsonb_agg(to_jsonb(s) order by player_id) from public.roster_substitutes s where comp_ref=comp) is distinct from subs_before then raise exception 'Failed save changed pool';end if;
 perform public.cc_save_roster(comp,original_rows);
 if not exists(select 1 from public.roster where comp_ref=comp and player_id=chosen->>'playerId') then raise exception 'Returning substitute to a team failed';end if;
 if exists(select 1 from public.roster_substitutes where comp_ref=comp and player_id=chosen->>'playerId') then raise exception 'Returned player still in pool';end if;
 if has_function_privilege('anon','public.cc_save_roster(text,jsonb)','execute') or has_function_privilege('authenticated','public.cc_save_roster(text,jsonb)','execute') then raise exception 'Write function publicly executable';end if;
 if has_table_privilege('anon','public.roster_substitutes','select') then raise exception 'Substitute pool exposed';end if;
end $$;
rollback;
