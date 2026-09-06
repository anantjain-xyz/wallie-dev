-- A creation request and its session commit together. Replaying the request
-- never rebinds attachments, consumes another session number, or queues a job.
create table internal.session_creation_requests (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  creator_member_id uuid not null references public.workspace_members(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid not null references public.sessions(id) on delete cascade,
  job_id uuid not null,
  run_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (workspace_id, creator_member_id, request_id)
);

alter table internal.session_creation_requests enable row level security;
revoke all on internal.session_creation_requests from public, anon, authenticated;
create index session_creation_requests_session_idx
  on internal.session_creation_requests(session_id);

create function public.find_session_creation_request(
  target_workspace_id uuid,
  creator_member_id uuid,
  target_request_id uuid,
  target_request_hash text
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  existing internal.session_creation_requests%rowtype;
begin
  if not exists (
    select 1 from public.workspace_members member
    where member.id = creator_member_id
      and member.workspace_id = target_workspace_id
      and member.kind = 'human'
      and member.is_active
  ) then
    raise exception 'Creator is not an active human workspace member' using errcode = '42501';
  end if;

  if target_request_id is null or target_request_hash is null
     or target_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A request id and SHA-256 fingerprint are required' using errcode = '22023';
  end if;

  select request.* into existing
  from internal.session_creation_requests request
  where request.workspace_id = target_workspace_id
    and request.creator_member_id = find_session_creation_request.creator_member_id
    and request.request_id = target_request_id;

  if not found then return; end if;
  if existing.request_hash <> target_request_hash then
    raise exception 'This creation request was already used for different session input'
      using errcode = 'P0005';
  end if;

  return query
  select session.id, session.number, workspace.slug, existing.job_id, existing.run_id
  from public.sessions session
  join public.workspaces workspace on workspace.id = session.workspace_id
  where session.id = existing.session_id
    and session.workspace_id = target_workspace_id;
end;
$$;

revoke all on function public.find_session_creation_request(uuid, uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.find_session_creation_request(uuid, uuid, uuid, text)
  to service_role;

create function public.create_session_once_with_first_job(
  target_workspace_id uuid,
  creator_member_id uuid,
  target_request_id uuid,
  target_request_hash text,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_attachment_ids uuid[],
  session_linear_issue_id text default null,
  session_linear_issue_url text default null,
  session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  result record;
begin
  -- Serialize only matching requests, including concurrent retries on another
  -- Vercel instance. The lock and every creation write share one transaction.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text,
    0
  ));

  select * into result from public.find_session_creation_request(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash
  );
  if found then
    return query select result.session_id::uuid, result.session_number::integer,
      result.workspace_slug::text, result.job_id::uuid, result.run_id::uuid;
    return;
  end if;

  select * into result from public.create_session_with_first_job_and_attachments(
    target_workspace_id, creator_member_id, session_title, session_prompt_md,
    agent_model_provider, agent_model_name, session_attachment_ids,
    session_linear_issue_id, session_linear_issue_url, session_github_repository_id,
    selected_pipeline_id, selected_stage_ids
  );

  insert into internal.session_creation_requests (
    workspace_id, creator_member_id, request_id, request_hash, session_id, job_id, run_id
  ) values (
    target_workspace_id, creator_member_id, target_request_id, target_request_hash,
    result.session_id, result.job_id, result.run_id
  );

  return query select result.session_id::uuid, result.session_number::integer,
    result.workspace_slug::text, result.job_id::uuid, result.run_id::uuid;
end;
$$;

revoke all on function public.create_session_once_with_first_job(
  uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[]
) from public, anon, authenticated;
grant execute on function public.create_session_once_with_first_job(
  uuid, uuid, uuid, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[]
) to service_role;
