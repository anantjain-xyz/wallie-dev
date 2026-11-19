-- Agent proposals are staged outside published session artifacts. A manager
-- transfers one exact accepted proposal to the versioned memory store.
create table internal.factory_run_memory_proposals (
  run_id uuid primary key references public.session_run_context_manifests(run_id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid not null references public.sessions(id) on delete cascade,
  attempt_count integer not null check (attempt_count > 0),
  artifact_sha256 text not null check (artifact_sha256 ~ '^[a-f0-9]{64}$'),
  body_md text not null check (octet_length(body_md) between 1 and 4096),
  body_sha256 text not null check (body_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create index factory_run_memory_proposals_session_idx on internal.factory_run_memory_proposals(session_id);
create index factory_run_memory_proposals_factory_idx on internal.factory_run_memory_proposals(workspace_id, factory_id);
create index factory_run_memory_proposals_created_idx on internal.factory_run_memory_proposals(created_at, run_id);
alter table internal.factory_run_memory_proposals enable row level security;
revoke all on internal.factory_run_memory_proposals from public, anon, authenticated, service_role;

create function public.stage_factory_run_memory_proposal(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer,
  p_artifact_sha256 text, p_body_md text
)
returns boolean language plpgsql security definer set search_path = '' as $$
declare job public.agent_jobs;
declare scope_factory uuid;
declare proposal_sha256 text;
begin
  job := internal.lock_factory_run_context_attempt(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  if p_artifact_sha256 is null or p_artifact_sha256 !~ '^[a-f0-9]{64}$'
    or p_body_md is null or octet_length(p_body_md) not between 1 and 4096 or btrim(p_body_md, E' \t\r\n') = '' then
    raise exception 'Factory memory staging requires an exact artifact digest and 1 to 4096 UTF-8 bytes.' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.session_run_context_manifests frozen
    where (frozen.workspace_id, frozen.session_id, frozen.job_id, frozen.run_id, frozen.attempt_count) =
      (p_workspace_id, job.session_id, p_job_id, p_run_id, p_attempt_count)
      and frozen.manifest->'version' = '2'::jsonb
  ) then return false; end if;

  select factory_id into strict scope_factory from public.sessions where (workspace_id, id) = (p_workspace_id, job.session_id);
  proposal_sha256 := encode(sha256(convert_to(p_body_md, 'UTF8')), 'hex');
  insert into internal.factory_run_memory_proposals (
    workspace_id, factory_id, session_id, run_id, attempt_count, artifact_sha256, body_md, body_sha256
  ) values (
    p_workspace_id, scope_factory, job.session_id, p_run_id, p_attempt_count, p_artifact_sha256, p_body_md, proposal_sha256
  ) on conflict (run_id) do nothing;
  if found then return true; end if;
  return exists (
    select 1 from internal.factory_run_memory_proposals staged
    where (staged.workspace_id, staged.factory_id, staged.session_id, staged.run_id, staged.attempt_count) =
      (p_workspace_id, scope_factory, job.session_id, p_run_id, p_attempt_count)
      and (staged.artifact_sha256, staged.body_sha256, staged.body_md) = (p_artifact_sha256, proposal_sha256, p_body_md)
  );
end;
$$;
revoke all on function public.stage_factory_run_memory_proposal(uuid, uuid, uuid, integer, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.stage_factory_run_memory_proposal(uuid, uuid, uuid, integer, text, text) to service_role;

create table public.factory_memories (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  title text check (char_length(title) between 1 and 120 and title !~ '[[:cntrl:]]'),
  -- Provenance remains meaningful after source content is removed by retention.
  source_session_id uuid not null,
  source_artifact_id uuid not null,
  source_artifact_version integer not null check (source_artifact_version > 0),
  source_run_id uuid not null,
  source_attempt_count integer not null check (source_attempt_count > 0),
  source_commit_sha text not null check (source_commit_sha ~ '^[a-f0-9]{40}$'),
  source_content_sha256 text not null check (source_content_sha256 ~ '^[a-f0-9]{64}$'),
  current_revision_id uuid,
  pending_revision_id uuid,
  current_approval_id uuid,
  forgotten_at timestamptz,
  created_at timestamptz not null default now(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, source_artifact_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  check ((current_revision_id is null) = (current_approval_id is null)),
  check (current_revision_id is distinct from pending_revision_id or current_revision_id is null),
  constraint factory_memory_title_retention check ((title is null) = (forgotten_at is not null)),
  check (forgotten_at is null or (current_revision_id is null and pending_revision_id is null))
);

create table public.factory_memory_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  memory_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  content_sha256 text not null check (content_sha256 ~ '^[a-f0-9]{64}$'),
  expires_at timestamptz,
  supersedes_revision_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, factory_id, memory_id, id),
  unique (workspace_id, factory_id, memory_id, revision_number),
  foreign key (workspace_id, factory_id, memory_id)
    references public.factory_memories(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, memory_id, supersedes_revision_id)
    references public.factory_memory_revisions(workspace_id, factory_id, memory_id, id)
);

-- Separating bodies preserves immutable provenance and review decisions on forget.
create table public.factory_memory_revision_bodies (
  workspace_id uuid not null,
  factory_id uuid not null,
  memory_id uuid not null,
  revision_id uuid primary key,
  body_md text not null check (octet_length(body_md) between 1 and 4096),
  foreign key (workspace_id, factory_id, memory_id, revision_id)
    references public.factory_memory_revisions(workspace_id, factory_id, memory_id, id) on delete cascade
);

create table public.factory_memory_review_events (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  memory_id uuid not null,
  revision_id uuid,
  -- Retain historical actor identity if the member is later removed.
  actor_member_id uuid not null,
  action text not null check (action in ('proposed', 'corrected', 'approved', 'rejected', 'forgotten')),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, memory_id, revision_id, id),
  foreign key (workspace_id, factory_id, memory_id)
    references public.factory_memories(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, memory_id, revision_id)
    references public.factory_memory_revisions(workspace_id, factory_id, memory_id, id),
  check (revision_id is not null or action = 'forgotten')
);

alter table public.factory_memories
  add foreign key (workspace_id, factory_id, id, current_revision_id)
    references public.factory_memory_revisions(workspace_id, factory_id, memory_id, id),
  add foreign key (workspace_id, factory_id, id, pending_revision_id)
    references public.factory_memory_revisions(workspace_id, factory_id, memory_id, id),
  add foreign key (workspace_id, factory_id, id, current_revision_id, current_approval_id)
    references public.factory_memory_review_events(workspace_id, factory_id, memory_id, revision_id, id);

create index factory_memory_eligible_idx on public.factory_memories(workspace_id, factory_id, created_at desc, id)
  where current_revision_id is not null and forgotten_at is null;
create index factory_memory_bodies_family_idx on public.factory_memory_revision_bodies(workspace_id, factory_id, memory_id);
create index factory_memory_events_family_idx on public.factory_memory_review_events(workspace_id, factory_id, memory_id, created_at, id);

alter table public.factory_memories enable row level security;
alter table public.factory_memory_revisions enable row level security;
alter table public.factory_memory_revision_bodies enable row level security;
alter table public.factory_memory_review_events enable row level security;
revoke all on public.factory_memories, public.factory_memory_revisions,
  public.factory_memory_revision_bodies, public.factory_memory_review_events
  from public, anon, authenticated, service_role;
grant select on public.factory_memories, public.factory_memory_revisions,
  public.factory_memory_revision_bodies, public.factory_memory_review_events to authenticated;

create policy factory_memory_manager_select on public.factory_memories for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_memory_revision_manager_select on public.factory_memory_revisions for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_memory_body_manager_select on public.factory_memory_revision_bodies for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));
create policy factory_memory_event_manager_select on public.factory_memory_review_events for select to authenticated
  using (internal.can_manage_factory(workspace_id, factory_id));

create function internal.guard_factory_memory_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factory_memories memory
    where (memory.workspace_id, memory.factory_id, memory.id) =
      (old.workspace_id, old.factory_id, old.memory_id)
  ) then
    return old;
  end if;
  raise exception 'Factory memory history is immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.guard_factory_memory_history() from public, anon, authenticated, service_role;
create trigger factory_memory_revision_immutable before update or delete on public.factory_memory_revisions
  for each row execute function internal.guard_factory_memory_history();
create trigger factory_memory_review_event_immutable before update or delete on public.factory_memory_review_events
  for each row execute function internal.guard_factory_memory_history();

create function internal.lock_factory_memory(
  p_workspace_id uuid, p_factory_id uuid, p_memory_id uuid,
  p_expected_current_revision_id uuid, p_expected_pending_revision_id uuid
)
returns public.factory_memories language plpgsql set search_path = '' as $$
declare memory public.factory_memories;
begin
  select * into memory from public.factory_memories
  where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_memory_id)
  for update;
  if not found then
    raise exception 'Factory memory is unavailable.' using errcode = 'P0002';
  end if;
  if memory.forgotten_at is not null
    or memory.current_revision_id is distinct from p_expected_current_revision_id
    or memory.pending_revision_id is distinct from p_expected_pending_revision_id then
    raise exception 'Factory memory has changed.' using errcode = 'PT409';
  end if;
  return memory;
end;
$$;
revoke all on function internal.lock_factory_memory(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function internal.insert_factory_memory_revision(
  p_memory public.factory_memories, p_body_md text, p_expires_at timestamptz,
  p_previous_revision_id uuid default null
)
returns uuid language plpgsql set search_path = '' as $$
declare revision_id uuid;
begin
  if p_body_md is null or btrim(p_body_md, E' \t\r\n') = '' or octet_length(p_body_md) > 4096 then
    raise exception 'Factory memory requires content of at most 4096 UTF-8 bytes.' using errcode = '22023';
  end if;
  if p_expires_at is not null and (not isfinite(p_expires_at) or p_expires_at <= clock_timestamp()) then
    raise exception 'Factory memory expiry must be in the future.' using errcode = '22023';
  end if;
  insert into public.factory_memory_revisions (
    workspace_id, factory_id, memory_id, revision_number, content_sha256, expires_at, supersedes_revision_id
  ) select p_memory.workspace_id, p_memory.factory_id, p_memory.id,
    coalesce(max(revision.revision_number), 0) + 1,
    encode(sha256(convert_to(p_body_md, 'UTF8')), 'hex'), p_expires_at, p_previous_revision_id
  from public.factory_memory_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.memory_id) =
    (p_memory.workspace_id, p_memory.factory_id, p_memory.id)
  returning id into revision_id;
  insert into public.factory_memory_revision_bodies (workspace_id, factory_id, memory_id, revision_id, body_md)
  values (p_memory.workspace_id, p_memory.factory_id, p_memory.id, revision_id, p_body_md);
  return revision_id;
end;
$$;
revoke all on function internal.insert_factory_memory_revision(public.factory_memories, text, timestamptz, uuid)
  from public, anon, authenticated, service_role;

create function internal.find_factory_run_memory_proposal(
  p_workspace_id uuid, p_factory_id uuid, p_artifact_id uuid, p_artifact_version integer
)
returns table(session_id uuid, run_id uuid, attempt_count integer, commit_sha text, artifact_sha256 text)
language sql stable set search_path = '' as $$
  select session.id, producer.run_id, producer.attempt_count, producer.commit_sha, staged.artifact_sha256
  from public.session_artifacts artifact
  join public.sessions session on (session.workspace_id, session.id) = (artifact.workspace_id, artifact.session_id)
  join public.factories factory on (factory.workspace_id, factory.id) = (session.workspace_id, session.factory_id)
  cross join lateral internal.factory_session_artifact_producer(artifact, session.github_repository_id) producer
  join internal.factory_run_memory_proposals staged
    on (staged.workspace_id, staged.factory_id, staged.session_id, staged.run_id, staged.attempt_count) =
      (session.workspace_id, session.factory_id, session.id, producer.run_id, producer.attempt_count)
  where (artifact.workspace_id, session.factory_id, artifact.id, artifact.version) =
    (p_workspace_id, p_factory_id, p_artifact_id, p_artifact_version)
    and factory.status = 'active'
    and jsonb_typeof(artifact.artifact_json) = 'string'
    and octet_length(artifact.artifact_json #>> '{}') <= 1048576
    and staged.artifact_sha256 = encode(sha256(convert_to(artifact.artifact_json #>> '{}', 'UTF8')), 'hex')
$$;
revoke all on function internal.find_factory_run_memory_proposal(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;

create function public.has_factory_run_memory_proposal(
  p_workspace_id uuid, p_factory_id uuid, p_artifact_id uuid, p_artifact_version integer
)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if not internal.can_manage_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory manager access is required.' using errcode = '42501';
  end if;
  return exists (select 1 from internal.find_factory_run_memory_proposal(
    p_workspace_id, p_factory_id, p_artifact_id, p_artifact_version
  ));
end;
$$;
revoke all on function public.has_factory_run_memory_proposal(uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.has_factory_run_memory_proposal(uuid, uuid, uuid, integer) to authenticated;

create function public.propose_factory_memory(
  p_workspace_id uuid, p_factory_id uuid, p_artifact_id uuid, p_artifact_version integer,
  p_title text, p_expires_at timestamptz default null
)
returns public.factory_memories language plpgsql security definer set search_path = '' as $$
declare actor_id uuid;
declare memory public.factory_memories;
declare proposal record;
declare proposal_body text;
declare revision_id uuid;
begin
  actor_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, auth.uid());
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_title is null or char_length(btrim(p_title)) not between 1 and 120 or p_title ~ '[[:cntrl:]]' then
    raise exception 'Factory memory title must contain 1 to 120 characters on one line.' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.factory_memories prior
    where (prior.workspace_id, prior.factory_id, prior.source_artifact_id, prior.source_artifact_version) =
      (p_workspace_id, p_factory_id, p_artifact_id, p_artifact_version)
  ) then
    raise exception 'This artifact already proposed factory memory.' using errcode = 'PT409';
  end if;

  select * into proposal from internal.find_factory_run_memory_proposal(
    p_workspace_id, p_factory_id, p_artifact_id, p_artifact_version
  );
  if not found then
    raise exception 'Exact factory memory source proposal is unavailable.' using errcode = 'P0002';
  end if;

  delete from internal.factory_run_memory_proposals staged
  where (staged.workspace_id, staged.factory_id, staged.session_id, staged.run_id, staged.attempt_count, staged.artifact_sha256) =
    (p_workspace_id, p_factory_id, proposal.session_id, proposal.run_id, proposal.attempt_count, proposal.artifact_sha256)
  returning staged.body_md into proposal_body;
  if not found then
    raise exception 'Exact factory memory source proposal is unavailable.' using errcode = 'P0002';
  end if;

  insert into public.factory_memories (
    workspace_id, factory_id, title, source_session_id, source_artifact_id, source_artifact_version,
    source_run_id, source_attempt_count, source_commit_sha, source_content_sha256
  ) values (
    p_workspace_id, p_factory_id, btrim(p_title), proposal.session_id, p_artifact_id, p_artifact_version,
    proposal.run_id, proposal.attempt_count, proposal.commit_sha, proposal.artifact_sha256
  )
  on conflict (workspace_id, factory_id, source_artifact_id) do nothing returning * into memory;
  if not found then
    raise exception 'This artifact already proposed factory memory.' using errcode = 'PT409';
  end if;
  revision_id := internal.insert_factory_memory_revision(memory, proposal_body, p_expires_at);
  insert into public.factory_memory_review_events (workspace_id, factory_id, memory_id, revision_id, actor_member_id, action)
  values (p_workspace_id, p_factory_id, memory.id, revision_id, actor_id, 'proposed');
  update public.factory_memories set pending_revision_id = revision_id where id = memory.id returning * into memory;
  return memory;
end;
$$;

create function public.correct_factory_memory(
  p_workspace_id uuid, p_factory_id uuid, p_memory_id uuid, p_body_md text,
  p_expected_current_revision_id uuid default null, p_expected_pending_revision_id uuid default null,
  p_expires_at timestamptz default null
)
returns public.factory_memories language plpgsql security definer set search_path = '' as $$
declare actor_id uuid;
declare memory public.factory_memories;
declare previous_revision_id uuid;
declare next_revision_id uuid;
begin
  actor_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, auth.uid());
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  memory := internal.lock_factory_memory(
    p_workspace_id, p_factory_id, p_memory_id, p_expected_current_revision_id, p_expected_pending_revision_id
  );
  select revision.id into strict previous_revision_id from public.factory_memory_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.memory_id) =
    (p_workspace_id, p_factory_id, p_memory_id)
  order by revision.revision_number desc limit 1;
  next_revision_id := internal.insert_factory_memory_revision(memory, p_body_md, p_expires_at, previous_revision_id);
  insert into public.factory_memory_review_events (workspace_id, factory_id, memory_id, revision_id, actor_member_id, action)
  values (p_workspace_id, p_factory_id, memory.id, next_revision_id, actor_id, 'corrected');
  update public.factory_memories set current_revision_id = null, current_approval_id = null,
    pending_revision_id = next_revision_id where id = memory.id returning * into memory;
  return memory;
end;
$$;

create function public.review_factory_memory(
  p_workspace_id uuid, p_factory_id uuid, p_memory_id uuid, p_decision text,
  p_expected_current_revision_id uuid default null, p_expected_pending_revision_id uuid default null
)
returns public.factory_memories language plpgsql security definer set search_path = '' as $$
declare actor_id uuid;
declare memory public.factory_memories;
declare approval_event_id uuid;
begin
  actor_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, auth.uid());
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'Factory memory decision must be approve or reject.' using errcode = '22023';
  end if;
  memory := internal.lock_factory_memory(
    p_workspace_id, p_factory_id, p_memory_id, p_expected_current_revision_id, p_expected_pending_revision_id
  );
  if memory.pending_revision_id is null then
    raise exception 'Factory memory has no pending revision.' using errcode = 'PT409';
  end if;

  if p_decision = 'approve' and not exists (
    select 1 from public.factory_memory_revisions revision
    join public.factory_memory_revision_bodies body
      on (body.workspace_id, body.factory_id, body.memory_id, body.revision_id) =
         (revision.workspace_id, revision.factory_id, revision.memory_id, revision.id)
    where (revision.workspace_id, revision.factory_id, revision.memory_id, revision.id) =
      (p_workspace_id, p_factory_id, p_memory_id, memory.pending_revision_id)
      and (revision.expires_at is null or revision.expires_at > clock_timestamp())
  ) then
    raise exception 'Pending factory memory is unavailable or expired.' using errcode = 'PT409';
  end if;
  insert into public.factory_memory_review_events (workspace_id, factory_id, memory_id, revision_id, actor_member_id, action)
  values (p_workspace_id, p_factory_id, p_memory_id, memory.pending_revision_id, actor_id,
    case p_decision when 'approve' then 'approved' else 'rejected' end)
  returning id into approval_event_id;
  update public.factory_memories set
    current_revision_id = case when p_decision = 'approve' then memory.pending_revision_id else memory.current_revision_id end,
    current_approval_id = case when p_decision = 'approve' then approval_event_id else memory.current_approval_id end,
    pending_revision_id = null
  where id = p_memory_id returning * into memory;
  return memory;
end;
$$;

create function public.forget_factory_memory(
  p_workspace_id uuid, p_factory_id uuid, p_memory_id uuid,
  p_expected_current_revision_id uuid default null, p_expected_pending_revision_id uuid default null
)
returns public.factory_memories language plpgsql security definer set search_path = '' as $$
declare actor_id uuid;
declare memory public.factory_memories;
begin
  actor_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, auth.uid());
  memory := internal.lock_factory_memory(
    p_workspace_id, p_factory_id, p_memory_id, p_expected_current_revision_id, p_expected_pending_revision_id
  );
  insert into public.factory_memory_review_events (workspace_id, factory_id, memory_id, revision_id, actor_member_id, action)
  values (p_workspace_id, p_factory_id, memory.id, coalesce(memory.current_revision_id, memory.pending_revision_id), actor_id, 'forgotten');
  update public.factory_memories set title = null, current_revision_id = null, current_approval_id = null,
    pending_revision_id = null, forgotten_at = clock_timestamp()
  where id = p_memory_id returning * into memory;
  delete from public.factory_memory_revision_bodies
  where (workspace_id, factory_id, memory_id) = (p_workspace_id, p_factory_id, p_memory_id);
  return memory;
end;
$$;

revoke all on function public.propose_factory_memory(uuid, uuid, uuid, integer, text, timestamptz),
  public.correct_factory_memory(uuid, uuid, uuid, text, uuid, uuid, timestamptz),
  public.review_factory_memory(uuid, uuid, uuid, text, uuid, uuid),
  public.forget_factory_memory(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.propose_factory_memory(uuid, uuid, uuid, integer, text, timestamptz),
  public.correct_factory_memory(uuid, uuid, uuid, text, uuid, uuid, timestamptz),
  public.review_factory_memory(uuid, uuid, uuid, text, uuid, uuid),
  public.forget_factory_memory(uuid, uuid, uuid, uuid, uuid)
  to authenticated;

create function public.read_factory_memory_context(
  p_workspace_id uuid, p_factory_id uuid, p_revision_ids uuid[] default null
)
returns table(memory_id uuid, revision_id uuid, body_md text, content_sha256 text, approval_id uuid)
language plpgsql security definer set search_path = '' as $$
begin
  if p_revision_ids is not null and (
    cardinality(p_revision_ids) > 8
    or exists (select 1 from unnest(p_revision_ids) requested(id) group by requested.id
               having requested.id is null or count(*) > 1)
  ) then
    raise exception 'Provide at most eight distinct factory memory revision IDs.' using errcode = '22023';
  end if;

  return query
  select memory.id, revision.id, body.body_md, revision.content_sha256, approval.id
  from public.factory_memories memory
  join public.factories factory
    on (factory.workspace_id, factory.id) = (memory.workspace_id, memory.factory_id)
  join public.workspaces workspace on workspace.id = memory.workspace_id
  join public.factory_memory_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.memory_id, revision.id) =
       (memory.workspace_id, memory.factory_id, memory.id, memory.current_revision_id)
  join public.factory_memory_revision_bodies body
    on (body.workspace_id, body.factory_id, body.memory_id, body.revision_id) =
       (revision.workspace_id, revision.factory_id, revision.memory_id, revision.id)
  join public.factory_memory_review_events approval
    on (approval.workspace_id, approval.factory_id, approval.memory_id, approval.revision_id, approval.id) =
       (memory.workspace_id, memory.factory_id, memory.id, memory.current_revision_id, memory.current_approval_id)
  where (memory.workspace_id, memory.factory_id) = (p_workspace_id, p_factory_id)
    and memory.forgotten_at is null and factory.status = 'active' and workspace.deletion_requested_at is null
    and (revision.expires_at is null or revision.expires_at > clock_timestamp())
    and approval.action = 'approved'
    and (p_revision_ids is null or revision.id = any(p_revision_ids))
  order by array_position(p_revision_ids, revision.id), memory.created_at desc, memory.id
  limit 8;
end;
$$;
revoke all on function public.read_factory_memory_context(uuid, uuid, uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.read_factory_memory_context(uuid, uuid, uuid[]) to service_role;
