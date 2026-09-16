-- Uses the real scanned fixture inside a transaction which is always rolled back.
begin;
set local role service_role;
do $$
declare m jsonb;g jsonb;bad jsonb;result jsonb;scan text;
begin
 select to_jsonb(x)||jsonb_build_object('match_id','test-offline-recovery','source','app') into m from public.match_log x where fixture_id='WPM202607-R10-L2-M3';
 if m is null or m->>'source'<>'app' then raise exception 'Test fixture missing';end if;
 -- The payload has a new app ID; game rows still belong to the scanned record.
 select jsonb_agg(to_jsonb(x) order by game_no) into g from public.game_log x where match_id='scan-WPM202607-R10-L2-M3';
 scan:=m->>'scan_link';
 -- Change only a losing score, keeping the game and match otherwise valid.
 if (g->0->>'points_p1')::int < (g->0->>'points_p2')::int then
  bad:=jsonb_set(g,'{0,points_p1}',to_jsonb(case when (g->0->>'points_p1')::int=0 then 1 else (g->0->>'points_p1')::int-1 end));
 else
  bad:=jsonb_set(g,'{0,points_p2}',to_jsonb(case when (g->0->>'points_p2')::int=0 then 1 else (g->0->>'points_p2')::int-1 end));
 end if;
 begin
  perform public.cc_submit_queued_result(m,bad,'[]');
  raise exception 'Mismatching games were accepted';
 exception when unique_violation then null;
 end;
 result:=public.cc_submit_queued_result(m,g,'[]');
 if not (result->>'matchedScan')::boolean then raise exception 'Matching scan not recovered';end if;
 if not exists(select 1 from public.match_log where match_id='test-offline-recovery' and scan_link=scan) then raise exception 'Scan link lost';end if;
 if not exists(select 1 from court_card_private.result_archive where fixture_id='WPM202607-R10-L2-M3' and snapshot->'match'->>'source'='scan') then raise exception 'Original scan not archived';end if;
 raise notice 'PASS matching queued result recovers scan; differing scores rejected; scan retained and archived';
end $$;
rollback;
