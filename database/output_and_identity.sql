-- Service-only output configuration and explicit identity aliases.
alter table public.comps add column if not exists output_workbook_id text;
create unique index if not exists comps_output_workbook_unique on public.comps(output_workbook_id) where output_workbook_id is not null;
create table if not exists public.player_aliases (
 alias_id text primary key references public.players(player_id),
 player_id text not null references public.players(player_id),
 check(alias_id<>player_id)
);
alter table public.player_aliases enable row level security;
revoke all on public.player_aliases from public,anon,authenticated;
grant all on public.player_aliases to service_role;
create index if not exists player_aliases_player_idx on public.player_aliases(player_id);

create or replace function public.cc_resolve_player(p_name text,p_email text default null,p_phone text default null,p_grade text default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare nm text:=btrim(p_name); norm text; p public.players%rowtype; hits int; new_id text;
begin
 if nm is null or length(nm)<2 or length(nm)>150 then raise exception 'Player name must contain 2 to 150 characters' using errcode='22023';end if;
 norm:=regexp_replace(regexp_replace(lower(nm),'\s+',' ','g'),'[^a-z0-9 ]','','g');
 perform pg_advisory_xact_lock(hashtextextended('court-card-player:'||norm,0));
 select count(*) into hits from public.players where regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g')=norm and not exists(select 1 from public.player_aliases a where a.alias_id=players.player_id);
 if hits>1 then raise exception 'Ambiguous player name; administrator must resolve duplicate identities' using errcode='22023';end if;
 select * into p from public.players where regexp_replace(regexp_replace(lower(btrim(name)),'\s+',' ','g'),'[^a-z0-9 ]','','g')=norm and not exists(select 1 from public.player_aliases a where a.alias_id=players.player_id);
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