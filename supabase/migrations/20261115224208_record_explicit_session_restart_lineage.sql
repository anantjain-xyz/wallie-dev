-- An explicit restart admits a distinct session and leases a fresh source
-- lineage. Keep its origin identifier even if the old session is later deleted.
create table public.session_restart_lineages (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source_session_id uuid not null check (source_session_id <> session_id),
  linear_issue_context_id text,
  created_at timestamptz not null default clock_timestamp()
);
create index session_restart_lineages_workspace_idx on public.session_restart_lineages(workspace_id);

alter table public.session_restart_lineages enable row level security;
revoke all on public.session_restart_lineages from public, anon, authenticated, service_role;
grant select on public.session_restart_lineages to service_role;

create function internal.preserve_session_restart_lineage()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then return old; end if;
  raise exception 'Session restart lineage is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_session_restart_lineage() from public, anon, authenticated, service_role;
create trigger preserve_session_restart_lineage before update or delete on public.session_restart_lineages
  for each row execute function internal.preserve_session_restart_lineage();

-- These entry points need the workspace fence before canonical admission.
-- Match attachment admission's ordering so a queued activation can't invert it.
create function internal.lock_factory_session_creation_attachments(
  p_workspace_id uuid, p_member_id uuid, p_attachment_ids uuid[]
) returns void language plpgsql security invoker set search_path = '' as $$
declare locked_count integer;
begin
  if coalesce(cardinality(p_attachment_ids), 0) = 0 then return; end if;
  perform a.id from public.session_attachments a
  where a.id = any(p_attachment_ids) and a.workspace_id = p_workspace_id
    and a.uploaded_by_member_id = p_member_id and a.session_id is null
    and a.status = 'ready' and a.expires_at > now()
  order by a.id for update;
  get diagnostics locked_count = row_count;
  if locked_count <> cardinality(p_attachment_ids) then
    raise exception 'Session attachments changed, expired, or are not available' using errcode = 'P0004';
  end if;
end;
$$;
revoke all on function internal.lock_factory_session_creation_attachments(uuid,uuid,uuid[])
  from public, anon, authenticated, service_role;

create function public.restart_session_once_with_first_job(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  source_session_id uuid, session_title text, session_prompt_md text, agent_model_provider text,
  agent_model_name text, session_attachment_ids uuid[], session_linear_issue_id text default null,
  session_linear_issue_url text default null, session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null, selected_stage_ids uuid[] default null
)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  result record;
  source_issue_id text;
begin
  -- Share the existing creation-request lock so ordinary creation and an
  -- explicit restart cannot both commit under one request ID.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into result from public.find_session_creation_request(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash);
  if found then
    if not exists (
      select 1 from public.session_restart_lineages lineage
      where (lineage.workspace_id, lineage.session_id, lineage.source_session_id) =
        (target_workspace_id, result.session_id, restart_session_once_with_first_job.source_session_id)
    ) then
      raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
    end if;
  else
    -- Retain the existing Linear owner when the fresh session cites the same
    -- issue as context. The new session can still link to the original URL.
    perform internal.lock_factory_session_creation_attachments(target_workspace_id, creator_member_id, session_attachment_ids);
    perform internal.assert_workspace_accepts_work(target_workspace_id);
    select coalesce(source.linear_issue_id, prior.linear_issue_context_id) into source_issue_id
    from public.sessions source
    left join public.session_restart_lineages prior
      on (prior.workspace_id, prior.session_id) = (source.workspace_id, source.id)
    where (source.workspace_id, source.id) =
      (target_workspace_id, restart_session_once_with_first_job.source_session_id)
    for key share of source;
    if not found then
      raise exception 'Source session is unavailable in this workspace.' using errcode = 'PT404';
    end if;
    select * into strict result from public.create_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      case when source_issue_id = session_linear_issue_id then null else session_linear_issue_id end,
      session_linear_issue_url, session_github_repository_id,
      selected_pipeline_id, selected_stage_ids);
    insert into public.session_restart_lineages (session_id, workspace_id, source_session_id, linear_issue_context_id)
    values (result.session_id, target_workspace_id, restart_session_once_with_first_job.source_session_id,
      case when source_issue_id = session_linear_issue_id then source_issue_id end);
  end if;
  return query select result.session_id::uuid, result.session_number::integer,
    result.workspace_slug::text, result.job_id::uuid, result.run_id::uuid;
end;
$$;

revoke all on function public.restart_session_once_with_first_job(
  uuid,uuid,uuid,text,uuid,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[]
) from public, anon, authenticated;
grant execute on function public.restart_session_once_with_first_job(
  uuid,uuid,uuid,text,uuid,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[]
) to service_role;
