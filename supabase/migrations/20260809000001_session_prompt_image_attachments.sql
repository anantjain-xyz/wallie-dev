-- Private image inputs uploaded before session creation and atomically bound
-- when the session, first job, and first run are created.

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'session-attachments',
  'session-attachments',
  false,
  4194304,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id)
do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

create table public.session_attachments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  session_id uuid references public.sessions(id) on delete cascade,
  uploaded_by_member_id uuid references public.workspace_members(id) on delete set null,
  original_filename text not null,
  content_type text not null,
  size_bytes bigint not null,
  storage_path text not null,
  position smallint,
  status text not null default 'ready',
  expires_at timestamptz,
  attached_at timestamptz,
  created_at timestamptz not null default now(),
  constraint session_attachments_storage_path_unique unique (storage_path),
  constraint session_attachments_filename_length_check
    check (length(original_filename) between 1 and 255),
  constraint session_attachments_content_type_check
    check (content_type in ('image/jpeg', 'image/png', 'image/webp')),
  constraint session_attachments_size_check
    check (size_bytes between 1 and 4194304),
  constraint session_attachments_position_check
    check (position is null or position between 1 and 5),
  constraint session_attachments_status_check
    check (status in ('ready', 'attached', 'deleting')),
  constraint session_attachments_lifecycle_check check (
    (
      status in ('ready', 'deleting')
      and session_id is null
      and position is null
      and expires_at is not null
      and attached_at is null
    )
    or
    (
      status = 'attached'
      and session_id is not null
      and position is not null
      and expires_at is null
      and attached_at is not null
    )
  )
);

create unique index session_attachments_session_position_unique
  on public.session_attachments (session_id, position)
  where session_id is not null;

create index session_attachments_ready_expiry_idx
  on public.session_attachments (expires_at, id)
  where status = 'ready' and session_id is null;

create index session_attachments_workspace_session_idx
  on public.session_attachments (workspace_id, session_id, position)
  where session_id is not null;

create or replace function internal.enforce_session_attachment_refs()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.sessions',
    new.session_id,
    'session_id'
  );
  perform internal.assert_workspace_match(
    new.workspace_id,
    'public.workspace_members',
    new.uploaded_by_member_id,
    'uploaded_by_member_id'
  );
  return new;
end;
$$;

create trigger session_attachments_enforce_refs
before insert or update on public.session_attachments
for each row execute function internal.enforce_session_attachment_refs();

alter table public.session_attachments enable row level security;

revoke all on public.session_attachments from public, anon, authenticated;
grant all on public.session_attachments to service_role;

create policy session_attachments_service_only
  on public.session_attachments
  for all
  to authenticated
  using (false)
  with check (false);

-- Keep the existing creation RPC callable during a rolling deployment. The
-- new wrapper calls it inside the same transaction after locking all requested
-- uploads, so no queued job can observe a partially-bound session.
create or replace function public.create_session_with_first_job_and_attachments(
  target_workspace_id uuid,
  creator_member_id uuid,
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
  attachment_count integer := coalesce(cardinality(session_attachment_ids), 0);
  bound_count integer;
  created record;
begin
  if attachment_count > 5 then
    raise exception 'A session may include at most five image attachments'
      using errcode = '22023';
  end if;

  if attachment_count > 0 then
    if array_position(session_attachment_ids, null) is not null
       or attachment_count <> (
         select count(distinct attachment_id)
         from unnest(session_attachment_ids) as requested(attachment_id)
       ) then
      raise exception 'Session attachment ids must be unique and non-null'
        using errcode = '22023';
    end if;

    -- Row locks serialize binding against explicit deletion and expiry cleanup.
    perform attachment.id
    from public.session_attachments attachment
    where attachment.id = any(session_attachment_ids)
    order by attachment.id
    for update;

    select count(*)
    into bound_count
    from public.session_attachments attachment
    where attachment.id = any(session_attachment_ids)
      and attachment.workspace_id = target_workspace_id
      and attachment.uploaded_by_member_id = creator_member_id
      and attachment.session_id is null
      and attachment.status = 'ready'
      and attachment.expires_at > now();

    if bound_count <> attachment_count then
      raise exception 'Session attachments changed, expired, or are not available'
        using errcode = 'P0004';
    end if;
  end if;

  select created_session.*
  into created
  from public.create_session_with_first_job(
    target_workspace_id => target_workspace_id,
    creator_member_id => creator_member_id,
    session_title => session_title,
    session_prompt_md => session_prompt_md,
    agent_model_provider => agent_model_provider,
    agent_model_name => agent_model_name,
    session_linear_issue_id => session_linear_issue_id,
    session_linear_issue_url => session_linear_issue_url,
    session_github_repository_id => session_github_repository_id,
    selected_pipeline_id => selected_pipeline_id,
    selected_stage_ids => selected_stage_ids
  ) created_session;

  if attachment_count > 0 then
    update public.session_attachments attachment
    set session_id = created.session_id,
        position = requested.ordinality,
        status = 'attached',
        expires_at = null,
        attached_at = now()
    from unnest(session_attachment_ids) with ordinality as requested(attachment_id, ordinality)
    where attachment.id = requested.attachment_id
      and attachment.workspace_id = target_workspace_id
      and attachment.uploaded_by_member_id = creator_member_id
      and attachment.status = 'ready'
      and attachment.session_id is null;

    get diagnostics bound_count = row_count;
    if bound_count <> attachment_count then
      raise exception 'Session attachments could not be bound atomically'
        using errcode = 'P0004';
    end if;
  end if;

  return query
  select
    created.session_id::uuid,
    created.session_number::integer,
    created.workspace_slug::text,
    created.job_id::uuid,
    created.run_id::uuid;
end;
$$;

revoke all on function public.create_session_with_first_job_and_attachments(
  uuid, uuid, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[]
) from public, anon, authenticated;

grant execute on function public.create_session_with_first_job_and_attachments(
  uuid, uuid, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[]
) to service_role;

-- Claim expired pending uploads before deleting objects. `skip locked` plus the
-- status transition prevents cleanup from racing the creation wrapper.
create or replace function public.claim_expired_session_attachments(
  max_count integer default 100
)
returns table (
  id uuid,
  storage_path text
)
language sql
security definer
set search_path = ''
as $$
  with candidates as (
    select attachment.id
    from public.session_attachments attachment
    where attachment.status = 'ready'
      and attachment.session_id is null
      and attachment.expires_at <= now()
    order by attachment.expires_at, attachment.id
    limit greatest(1, least(max_count, 500))
    for update skip locked
  )
  update public.session_attachments attachment
  set status = 'deleting'
  from candidates
  where attachment.id = candidates.id
  returning attachment.id, attachment.storage_path
$$;

revoke all on function public.claim_expired_session_attachments(integer)
  from public, anon, authenticated;
grant execute on function public.claim_expired_session_attachments(integer)
  to service_role;

-- Small, membership-aware projection used alongside the existing session
-- detail RPC without exposing the service-only metadata table directly.
create or replace function public.get_session_prompt_attachments(
  target_workspace_slug text,
  target_session_number integer
)
returns table (
  id uuid,
  original_filename text,
  content_type text,
  size_bytes bigint,
  attachment_position smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    attachment.id,
    attachment.original_filename,
    attachment.content_type,
    attachment.size_bytes,
    attachment.position
  from public.workspaces workspace
  join public.sessions session
    on session.workspace_id = workspace.id
   and session.number = target_session_number
  join public.session_attachments attachment
    on attachment.session_id = session.id
   and attachment.workspace_id = workspace.id
   and attachment.status = 'attached'
  where workspace.slug = target_workspace_slug
    and workspace.id in (select internal.current_user_workspace_ids())
  order by attachment.position
$$;

revoke all on function public.get_session_prompt_attachments(text, integer)
  from public, anon;
grant execute on function public.get_session_prompt_attachments(text, integer)
  to authenticated, service_role;
