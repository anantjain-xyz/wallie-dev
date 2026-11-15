create index agent_run_messages_run_created_id_idx
  on public.agent_run_messages(agent_run_id, created_at desc, id desc);
drop index public.agent_run_messages_agent_run_created_at_idx;

create function public.list_run_legacy_transcript(
  p_workspace_id uuid,
  p_run_id uuid,
  p_cursor_created_at timestamptz default null,
  p_cursor_id uuid default null,
  p_direction text default 'older',
  p_limit integer default 31
) returns table (
  id uuid,
  created_at timestamptz,
  kind text,
  message_excerpt text,
  message_truncated boolean
) language plpgsql stable security invoker set search_path = ''
  set plan_cache_mode = force_custom_plan as $$
begin
  if not exists(select 1 from public.workspaces w
    where w.id = p_workspace_id and w.deletion_requested_at is null) then
    raise exception 'Run transcript workspace is unavailable.' using errcode = 'P0002';
  end if;
  if p_direction is null or p_direction not in ('older', 'newer')
    or ((p_cursor_created_at is null) <> (p_cursor_id is null))
    or (p_direction = 'newer' and p_cursor_id is null) then
    raise exception 'Invalid legacy transcript cursor.' using errcode = '22023';
  end if;
  return query
  select m.id, m.created_at, left(m.kind, 64), left(m.message_md, 8192),
    char_length(m.message_md) > 8192
  from public.agent_run_messages m
  where m.workspace_id = p_workspace_id and m.agent_run_id = p_run_id
    and exists(select 1 from public.agent_runs r
      where r.id = p_run_id and r.workspace_id = p_workspace_id)
    and (p_cursor_id is null
      or (p_direction = 'older' and (m.created_at, m.id) < (p_cursor_created_at, p_cursor_id))
      or (p_direction = 'newer' and (m.created_at, m.id) > (p_cursor_created_at, p_cursor_id)))
  order by
    case when p_direction = 'newer' then m.created_at end asc,
    case when p_direction = 'newer' then m.id end asc,
    case when p_direction = 'older' then m.created_at end desc,
    case when p_direction = 'older' then m.id end desc
  limit least(greatest(coalesce(p_limit, 31), 1), 51);
end;
$$;

revoke all on function public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer)
  to authenticated;
comment on function public.list_run_legacy_transcript(uuid,uuid,timestamptz,uuid,text,integer)
  is 'RLS-scoped legacy history: at most 51 rows, each excerpt at most 8192 Unicode characters. The application additionally bounds serialized display entries to 8192 bytes.';
