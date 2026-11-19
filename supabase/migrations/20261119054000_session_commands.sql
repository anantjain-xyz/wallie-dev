-- Creation and feedback already own durable receipts. Reuse their transaction
-- boundaries and enforce the actor's access to the receipt's immutable factory.
create function internal.assert_session_command_access(
  p_workspace_id uuid, p_factory_id uuid, p_actor_member_id uuid
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if not exists (
    select 1 from public.workspaces workspace
    where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
  ) then
    raise exception 'Session not found.' using errcode = 'PT404';
  end if;
  perform internal.assert_factory_grant_invoker(p_workspace_id, p_factory_id, p_actor_member_id);
end;
$$;
revoke all on function internal.assert_session_command_access(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.find_session_creation_command(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  target_factory_id uuid default null, source_session_id uuid default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record;
begin
  if not exists (
    select 1 from public.workspace_members member
    where (member.workspace_id, member.id) = (target_workspace_id, creator_member_id)
      and member.kind = 'human' and member.is_active
  ) then
    raise exception 'Creator is not an active human workspace member' using errcode = '42501';
  end if;
  if target_request_id is null or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A request id and SHA-256 fingerprint are required' using errcode = '22023';
  end if;

  select request.session_id, session.number, workspace.slug, request.job_id, request.run_id,
    session.factory_id, lineage.source_session_id, request.request_hash into accepted
  from internal.session_creation_requests request
  join public.sessions session on (session.workspace_id, session.id) = (request.workspace_id, request.session_id)
  join public.workspaces workspace on workspace.id = request.workspace_id
  left join public.session_restart_lineages lineage
    on (lineage.workspace_id, lineage.session_id) = (request.workspace_id, request.session_id)
  where (request.workspace_id, request.creator_member_id, request.request_id) =
    (target_workspace_id, find_session_creation_command.creator_member_id, target_request_id)
  for key share of session;
  if not found then return; end if;

  perform internal.assert_session_command_access(target_workspace_id, accepted.factory_id, creator_member_id);
  if accepted.request_hash <> target_request_hash
    or accepted.source_session_id is distinct from source_session_id
    or (target_factory_id is not null and accepted.factory_id <> target_factory_id) then
    raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
  end if;
  return query select accepted.session_id, accepted.number, accepted.slug, accepted.job_id, accepted.run_id;
end;
$$;
revoke all on function public.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid)
  to service_role;

create function public.create_session_command_once(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record; admitted_factory_id uuid;
begin
  -- Share the original creation lock, including when an old entry point or a
  -- concurrent restart uses the same actor/workspace request key.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text
      || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_command(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash,
    target_factory_id, source_session_id);
  if not found then
    select * into strict accepted from public.create_confirmed_factory_session_once_with_first_job(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      expected_factory_definition_digest, session_title, session_prompt_md,
      agent_model_provider, agent_model_name, session_attachment_ids, session_linear_issue_id,
      session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
      selected_stage_ids, source_session_id);
    select session.factory_id into strict admitted_factory_id from public.sessions session
    where (session.workspace_id, session.id) = (target_workspace_id, accepted.session_id);
    -- Today the admission RPC selects the default factory. An explicit scope
    -- is a fence, enforced before any creation, attachment or enqueue commits.
    if target_factory_id is not null and admitted_factory_id <> target_factory_id then
      raise exception 'The active factory changed.' using errcode = 'P0003';
    end if;
    perform internal.assert_session_command_access(target_workspace_id, admitted_factory_id, creator_member_id);
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug,
    accepted.job_id, accepted.run_id;
end;
$$;
revoke all on function public.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid
) to service_role;

-- The batch remains the receipt owner and stores canonical thread order and
-- trimmed feedback. Record their fingerprint without rewriting review logic.
create function internal.session_follow_up_request_hash(
  p_session_id uuid, p_stage_id uuid, p_artifact_id uuid, p_artifact_version integer,
  p_review_revision bigint, p_selected_thread_ids uuid[], p_feedback text
) returns text language sql immutable set search_path = '' as $$
  select encode(extensions.digest(
    jsonb_build_array('review-follow-up/v1', p_session_id, p_stage_id, p_artifact_id,
      p_artifact_version, p_review_revision, p_selected_thread_ids, p_feedback)::text,
    'sha256'), 'hex');
$$;
revoke all on function internal.session_follow_up_request_hash(uuid, uuid, uuid, integer, bigint, uuid[], text)
  from public, anon, authenticated, service_role;

alter table public.artifact_feedback_batches add column request_hash text generated always as (
  internal.session_follow_up_request_hash(session_id, stage_id, artifact_id, artifact_version,
    review_revision, selected_thread_ids, whole_stage_feedback)
) stored not null;

create function public.submit_session_follow_up_once(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_feedback_text text,
  p_expected_review_revision bigint default null, p_request_id uuid default null,
  p_selected_thread_ids uuid[] default null,
  p_agent_model_provider text default null, p_agent_model_name text default null,
  p_run_type text default null, p_requested_by_member_id uuid default null
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language plpgsql security definer set search_path = '' as $$
begin
  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, p_factory_id, p_session_id)
  for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  perform internal.assert_session_command_access(p_workspace_id, p_factory_id, p_requested_by_member_id);

  if p_expected_review_revision is null and p_request_id is null and p_selected_thread_ids is null then
    return query select rejected.*, null::uuid
    from public.reject_session_stage(
      p_session_id, p_workspace_id, p_artifact_version, p_feedback_text, p_agent_model_provider,
      p_agent_model_name, p_expected_stage_id, p_expected_artifact_id,
      coalesce(p_run_type, 'project'), p_requested_by_member_id) rejected;
    return;
  end if;

  -- The existing transaction compares canonical input, locks the reviewed
  -- artifact revision, and records the new job/run with its immutable batch.
  return query select * from public.submit_artifact_feedback_batch(
    p_session_id, p_workspace_id, p_artifact_version, p_expected_stage_id,
    p_expected_artifact_id, p_expected_review_revision, p_request_id, p_selected_thread_ids,
    p_feedback_text, p_agent_model_provider, p_agent_model_name, p_run_type, p_requested_by_member_id);
end;
$$;
revoke all on function public.submit_session_follow_up_once(
  uuid, uuid, uuid, integer, uuid, uuid, text, bigint, uuid, uuid[], text, text, text, uuid
) from public, anon, authenticated, service_role;
grant execute on function public.submit_session_follow_up_once(
  uuid, uuid, uuid, integer, uuid, uuid, text, bigint, uuid, uuid[], text, text, text, uuid
) to service_role;

create table internal.session_cancellation_requests (
  workspace_id uuid not null,
  factory_id uuid not null,
  actor_member_id uuid not null references public.workspace_members(id) on delete cascade,
  request_id uuid not null,
  request_hash text not null check (request_hash ~ '^[0-9a-f]{64}$'),
  session_id uuid not null references public.sessions(id) on delete cascade,
  expected_run_id uuid not null,
  job_ids uuid[] not null,
  run_ids uuid[] not null check (expected_run_id = any(run_ids)),
  created_at timestamptz not null default now(),
  primary key (workspace_id, factory_id, actor_member_id, request_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create index session_cancellation_requests_session_idx on internal.session_cancellation_requests(session_id);
create index session_cancellation_requests_actor_idx on internal.session_cancellation_requests(actor_member_id);
alter table internal.session_cancellation_requests enable row level security;
revoke all on internal.session_cancellation_requests from public, anon, authenticated, service_role;

create function public.cancel_session_command_once(
  target_workspace_id uuid, target_factory_id uuid, actor_member_id uuid, target_session_id uuid,
  target_request_id uuid, target_request_hash text, expected_run_id uuid
) returns table(job_ids uuid[], run_ids uuid[], replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  prior internal.session_cancellation_requests%rowtype;
  target public.sessions%rowtype;
  canceled record;
  reason constant text := 'Stage canceled by a workspace member.';
begin
  if target_request_id is null or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$'
    or expected_run_id is null then
    raise exception 'A request id, SHA-256 fingerprint and expected run are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-cancel:' || target_workspace_id::text || ':' || target_factory_id::text
      || ':' || actor_member_id::text || ':' || target_request_id::text, 0));
  select request.* into prior from internal.session_cancellation_requests request
  where (request.workspace_id, request.factory_id, request.actor_member_id, request.request_id) =
    (target_workspace_id, target_factory_id, cancel_session_command_once.actor_member_id, target_request_id);

  select session.* into target from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) =
    (target_workspace_id, target_factory_id, coalesce(prior.session_id, target_session_id))
  for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  perform internal.assert_session_command_access(target_workspace_id, target_factory_id, actor_member_id);
  if prior.request_id is not null then
    if prior.request_hash <> target_request_hash or prior.session_id is distinct from target_session_id
      or prior.expected_run_id <> expected_run_id then
      raise exception 'This cancellation request was already used for different input.' using errcode = 'P0005';
    end if;
    return query select prior.job_ids, prior.run_ids, true;
    return;
  end if;

  if target.phase_status <> 'in_progress' or target.archived_at is not null then
    raise exception 'Session is not generating.' using errcode = 'P0003';
  end if;
  select * into strict canceled from public.cancel_session_job_attempts(
    target.id, target_workspace_id, reason, expected_run_id, true);
  if not (expected_run_id = any(canceled.run_ids)) then
    raise exception 'Session generation changed.' using errcode = 'P0003';
  end if;

  -- Record the visible cancellation once. Sandbox cleanup can then retry using
  -- only the exact run IDs in the receipt, even after the session starts again.
  insert into public.agent_run_messages (workspace_id, agent_run_id, kind, message_md)
  select target_workspace_id, run.id, 'worker_error', '**Canceled:** ' || reason
  from public.agent_runs run
  where run.workspace_id = target_workspace_id and run.id = any(canceled.run_ids) and run.status = 'canceled';
  insert into internal.session_cancellation_requests (
    workspace_id, factory_id, actor_member_id, request_id, request_hash, session_id, expected_run_id, job_ids, run_ids
  ) values (
    target_workspace_id, target_factory_id, actor_member_id, target_request_id, target_request_hash,
    target.id, expected_run_id, canceled.job_ids, canceled.run_ids
  );
  return query select canceled.job_ids, canceled.run_ids, false;
end;
$$;
revoke all on function public.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.cancel_session_command_once(uuid, uuid, uuid, uuid, uuid, text, uuid)
  to service_role;
