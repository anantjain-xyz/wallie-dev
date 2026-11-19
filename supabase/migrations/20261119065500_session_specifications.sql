-- Specification is an admission choice on the first selected stage. Later
-- stages retain their existing configured identities and execution behavior.
alter table public.sessions add column specification_stage_id uuid references public.pipeline_stages(id);
alter table public.sessions add constraint specification_requires_pinned_definition
  check (specification_stage_id is null or execute_pinned_definition);
create index sessions_specification_stage_idx on public.sessions(specification_stage_id) where specification_stage_id is not null;

create type public.session_specification_clarification_status as enum ('pending', 'answered');
create table public.session_specification_clarifications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid not null,
  stage_id uuid not null,
  artifact_id uuid not null unique,
  artifact_version integer not null check (artifact_version > 0),
  run_id uuid not null,
  attempt_count integer not null check (attempt_count > 0),
  ordinal integer not null check (ordinal between 1 and 3),
  question text not null check (length(question) between 1 and 800),
  status public.session_specification_clarification_status not null default 'pending',
  created_at timestamptz not null default clock_timestamp(),
  answered_at timestamptz,
  answered_by_member_id uuid,
  answer_text text check (length(answer_text) between 1 and 2000),
  feedback_batch_id uuid,
  successor_job_id uuid,
  successor_run_id uuid,
  execution_exhausted boolean not null default false,
  unique (run_id, attempt_count),
  unique (session_id, ordinal),
  foreign key (session_id, workspace_id, factory_id) references public.sessions(id, workspace_id, factory_id) on delete cascade,
  check (
    (status = 'pending' and not execution_exhausted and answered_at is null and answered_by_member_id is null
      and answer_text is null and feedback_batch_id is null and successor_job_id is null and successor_run_id is null)
    or (status = 'answered' and answered_at is not null and answered_by_member_id is not null and answer_text is not null
      and feedback_batch_id is not null
      and ((execution_exhausted and successor_job_id is null and successor_run_id is null)
        or (not execution_exhausted and successor_job_id is not null and successor_run_id is not null)))
  )
);

create table internal.session_specification_clarification_answers (
  workspace_id uuid not null,
  actor_member_id uuid not null,
  request_id uuid not null,
  clarification_id uuid not null unique references public.session_specification_clarifications(id) on delete cascade,
  expected_review_revision bigint not null check (expected_review_revision >= 0),
  primary key (workspace_id, actor_member_id, request_id)
);

alter table public.session_specification_clarifications enable row level security;
alter table internal.session_specification_clarification_answers enable row level security;
revoke all on public.session_specification_clarifications, internal.session_specification_clarification_answers
  from public, anon, authenticated, service_role;
grant select on public.session_specification_clarifications to authenticated, service_role;
create policy session_specification_clarifications_read on public.session_specification_clarifications for select to authenticated
  using (internal.can_access_session(session_id));

create function internal.pin_session_specification_stage(p_session public.sessions)
returns void language plpgsql set search_path = '' as $$
declare requirements jsonb;
begin
  if not p_session.execute_pinned_definition or not exists (
    select 1 from public.factory_definition_revisions revision
    join public.factory_agents agent on (agent.workspace_id, agent.factory_id) = (revision.workspace_id, revision.factory_id)
      and agent.id::text = revision.definition_json::jsonb#>>'{implementationAgent,agentId}'
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (p_session.workspace_id, p_session.factory_id, p_session.factory_definition_revision_id)
  ) then
    raise exception 'Specification drafting requires a pinned definition with a named implementation agent.' using errcode = 'PT422';
  end if;

  select policy.requirements into requirements from public.delivery_policy_revisions policy
  where (policy.id, policy.workspace_id, policy.pipeline_id) =
    (p_session.pinned_delivery_policy_revision_id, p_session.workspace_id, p_session.pipeline_id);
  if requirements->>'deliveryMode' = 'code' and (requirements->>'requireArtifactApprovalForDelivery')::boolean is true
    and not exists (
      select 1 from internal.session_execution_stages(p_session) first_stage
      join internal.session_execution_stages(p_session) next_stage on next_stage.position > first_stage.position
      join public.session_selected_stages selected on (selected.session_id, selected.workspace_id, selected.stage_id) =
        (p_session.id, p_session.workspace_id, next_stage.id)
      where first_stage.id = p_session.current_stage_id
    ) then
    raise exception 'Select a later stage for delivery after the specification.' using errcode = 'PT422';
  end if;

  update public.sessions session set specification_stage_id = p_session.current_stage_id where session.id = p_session.id;
end;
$$;
revoke all on function internal.pin_session_specification_stage(public.sessions) from public, anon, authenticated, service_role;

create function internal.preserve_session_specification_stage()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.specification_stage_id is not null and new.specification_stage_id is distinct from old.specification_stage_id then
    raise exception 'Specification stage is fixed at session admission.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_session_specification_stage() from public, anon, authenticated, service_role;
create trigger preserve_session_specification_stage before update of specification_stage_id on public.sessions
  for each row execute function internal.preserve_session_specification_stage();

alter function public.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid) set schema internal;
revoke all on function internal.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.find_session_creation_command(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  target_factory_id uuid default null, source_session_id uuid default null, draft_specification boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record;
begin
  if draft_specification is null then raise exception 'Invalid specification drafting option.' using errcode = '22023'; end if;
  select * into accepted from internal.find_session_creation_command(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash, target_factory_id, source_session_id);
  if not found then return; end if;
  if draft_specification is distinct from (
    select session.specification_stage_id is not null from public.sessions session where session.id = accepted.session_id
  ) then
    raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;
revoke all on function public.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.find_session_creation_command(uuid, uuid, uuid, text, uuid, uuid, boolean) to service_role;

alter function public.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid
) set schema internal;
revoke all on function internal.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid
) from public, anon, authenticated, service_role;

create function public.create_session_command_once(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null,
  draft_specification boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record; admitted public.sessions;
begin
  -- The same creation receipt lock covers admitting and pinning the first stage.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_command(target_workspace_id, creator_member_id,
    target_request_id, target_request_hash, target_factory_id, source_session_id, draft_specification);
  if not found then
    select * into strict accepted from internal.create_session_command_once(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash, expected_factory_definition_digest,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
      selected_stage_ids, source_session_id, target_factory_id);
    if draft_specification then
      select * into strict admitted from public.sessions session where session.id = accepted.session_id;
      perform internal.pin_session_specification_stage(admitted);
    end if;
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;
revoke all on function public.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid, boolean
) from public, anon, authenticated, service_role;
grant execute on function public.create_session_command_once(
  uuid, uuid, uuid, text, text, text, text, text, text, uuid[], text, text, uuid, uuid, uuid[], uuid, uuid, boolean
) to service_role;

alter function public.get_session_detail_page(text, integer) set schema internal;
revoke all on function internal.get_session_detail_page(text, integer) from public, anon, authenticated, service_role;

create function public.get_session_detail_page(target_workspace_slug text, target_session_number integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare detail jsonb; specification_stage uuid;
begin
  detail := internal.get_session_detail_page(target_workspace_slug, target_session_number);
  if detail#>>'{session,id}' is null then return detail; end if;
  select session.specification_stage_id into specification_stage from public.sessions session
  where session.id = (detail#>>'{session,id}')::uuid;
  return jsonb_set(detail, '{session,specificationStageId}', coalesce(to_jsonb(specification_stage), 'null'::jsonb));
end;
$$;
revoke all on function public.get_session_detail_page(text, integer) from public, anon, authenticated, service_role;
grant execute on function public.get_session_detail_page(text, integer) to authenticated;

-- Fence changed source before an intent can authorize a retained remote ref.
create function internal.guard_specification_source_delivery()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.base_sha <> new.head_sha and exists (
    select 1 from public.agent_runs run join public.sessions session
      on (session.id, session.workspace_id, session.specification_stage_id) =
        (run.session_id, run.workspace_id, run.stage_id)
    where (run.id, run.agent_job_id, run.attempt_count, run.session_id, run.workspace_id) =
      (new.run_id, new.job_id, new.attempt_count, new.session_id, new.workspace_id)
  ) then
    raise exception 'Specification publication requires unchanged source from the exact execution attempt.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_specification_source_delivery() from public, anon, authenticated, service_role;
create trigger guard_specification_source_delivery before insert or update of base_sha, head_sha on public.session_source_deliveries
  for each row execute function internal.guard_specification_source_delivery();

-- The control line remains byte-for-byte in the immutable publication proof.
-- The existing safe Markdown renderer discards HTML comments in the artifact.
create function internal.session_specification_question(p_markdown text)
returns text language plpgsql immutable set search_path = '' as $$
declare
  first_line text := rtrim(split_part(p_markdown, E'\n', 1), E'\r');
  envelope text;
  metadata json;
  question text;
begin
  if length(first_line) > 8192 then return null; end if;
  envelope := substring(first_line from '^<!-- wallie-clarification: (.*) -->$');
  if envelope is null or strpos(envelope, '-->') > 0 then return null; end if;
  metadata := envelope::json;
  if json_typeof(metadata) <> 'object' then return null; end if;
  if (select count(*) from json_each(metadata)) <> 1
    or json_typeof(metadata->'question') is distinct from 'string' then return null; end if;
  question := btrim(metadata->>'question', E' \t\r\n');
  if length(question) not between 1 and 800 then return null; end if;
  return question;
exception when invalid_text_representation or untranslatable_character then
  return null;
end;
$$;
revoke all on function internal.session_specification_question(text) from public, anon, authenticated, service_role;

create function internal.checked_session_specification_question(p_session_id uuid, p_markdown text)
returns text language plpgsql set search_path = '' as $$
declare question text;
begin
  if not starts_with(p_markdown, '<!-- wallie-clarification:') then return null; end if;
  question := internal.session_specification_question(p_markdown);
  if question is null then
    raise exception 'Specification clarification must be one question of at most 800 characters.' using errcode = '23514';
  end if;
  if exists (select 1 from public.session_specification_clarifications clarification
    where clarification.session_id = p_session_id and clarification.ordinal = 3) then
    raise exception 'Specification clarification limit reached. Publish a final specification.' using errcode = '23514';
  end if;
  return question;
end;
$$;
revoke all on function internal.checked_session_specification_question(uuid, text) from public, anon, authenticated, service_role;

-- Preparation already owns the session, job and run locks. Reject a bad
-- directive before its immutable intent can get stuck in publication recovery.
create function internal.guard_specification_publication_intent()
returns trigger language plpgsql set search_path = '' as $$
begin
  if starts_with(new.artifact_md, '<!-- wallie-clarification:') and exists (
    select 1 from public.agent_runs run join public.sessions session
      on (session.id, session.workspace_id, session.specification_stage_id) =
        (run.session_id, run.workspace_id, run.stage_id)
    where (run.id, run.agent_job_id, run.attempt_count, run.session_id, run.workspace_id) =
      (new.run_id, new.job_id, new.attempt_count, new.session_id, new.workspace_id)
  ) then
    perform internal.checked_session_specification_question(new.session_id, new.artifact_md);
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_specification_publication_intent() from public, anon, authenticated, service_role;
create trigger guard_specification_publication_intent before insert on public.session_checkpoint_publications
  for each row execute function internal.guard_specification_publication_intent();

create or replace function internal.publish_session_job_attempt_with_conversation(
  p_job_id uuid, p_attempt_count integer, p_run_id uuid, p_expected_artifact_version integer,
  p_artifact_json text, p_deadline_at timestamptz
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  session public.sessions;
  run public.agent_runs;
  message public.session_conversation_messages;
  question text;
  question_ordinal integer;
begin
  if not internal.publish_session_job_attempt_without_conversation(
    p_job_id, p_attempt_count, p_run_id, p_expected_artifact_version, p_artifact_json, p_deadline_at) then
    return false;
  end if;
  select * into strict run from public.agent_runs where id = p_run_id;
  select * into strict session from public.sessions where id = run.session_id;
  message.body_md := 'An artifact is ready for review.';
  if run.stage_id = session.specification_stage_id then
    -- Inspect the exact captured input and unchanged source before the original
    -- publication, checkpoint, artifact and job transition can commit.
    if not exists (
      select 1 from public.session_source_deliveries delivery
      join public.session_job_git_inputs input on (input.job_id, input.workspace_id, input.session_id,
        input.pinned_run_id, input.pinned_attempt_count, input.repository_id, input.input_sha) =
        (delivery.job_id, delivery.workspace_id, delivery.session_id, delivery.run_id,
          delivery.attempt_count, delivery.repository_id, delivery.base_sha)
      where (delivery.run_id, delivery.job_id, delivery.attempt_count, delivery.session_id, delivery.workspace_id) =
        (run.id, p_job_id, p_attempt_count, session.id, session.workspace_id)
        and delivery.base_sha = delivery.head_sha
    ) then
      raise exception 'Specification publication requires unchanged source from the exact execution attempt.' using errcode = '23514';
    end if;
    message.body_md := 'A specification is ready for review.';
    question := internal.checked_session_specification_question(session.id, p_artifact_json);
    if question is not null then
      select coalesce(max(clarification.ordinal), 0) + 1 into question_ordinal
      from public.session_specification_clarifications clarification where clarification.session_id = session.id;
      insert into public.session_specification_clarifications (
        workspace_id, factory_id, session_id, stage_id, artifact_id, artifact_version, run_id, attempt_count, ordinal, question
      ) values (
        session.workspace_id, session.factory_id, session.id, run.stage_id, session.current_artifact_id,
        session.current_artifact_version, run.id, run.attempt_count, question_ordinal, question
      );
      message.body_md := 'Clarification needed: ' || question;
    end if;
  end if;
  message.kind := 'review_ready';
  message.author_kind := 'agent';
  message.author_label := coalesce((select agent.name from public.factory_agents agent
    where (agent.workspace_id, agent.factory_id, agent.id) = (session.workspace_id, session.factory_id, run.agent_id)), 'Wallie');
  message.originating_member_id := run.triggered_by_member_id;
  message.run_id := run.id;
  message.attempt_count := run.attempt_count;
  message.artifact_id := session.current_artifact_id;
  message.body_truncated := false;
  perform internal.append_session_conversation_message(session, message, 'review_ready:' || session.current_artifact_id::text);
  if p_deadline_at is not null and clock_timestamp() >= p_deadline_at then
    raise exception 'Worker attempt exceeded its publication deadline.' using errcode = '57014';
  end if;
  return true;
end;
$$;

alter function public.approve_session_stage(uuid, uuid, uuid, uuid, integer, uuid, text, text, text, bigint) set schema internal;
revoke all on function internal.approve_session_stage(uuid, uuid, uuid, uuid, integer, uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;

create function public.approve_session_stage(target_session_id uuid, expected_workspace_id uuid, expected_stage_id uuid,
  expected_artifact_id uuid, expected_version integer, approver_member_id uuid, p_agent_model_provider text,
  p_agent_model_name text, p_run_type text default 'project', p_expected_review_revision bigint default null)
returns table(id uuid,pipeline_id uuid,current_stage_id uuid,current_stage_slug text,phase_status public.pipeline_phase_status,
  workspace_id uuid,linear_issue_url text,archived_at timestamptz,current_artifact_version integer,rejection_count integer,
  job_id uuid,run_id uuid,job_created boolean)
language plpgsql security definer set search_path = '' as $$
declare reviewed public.sessions;
begin
  select * into reviewed from public.sessions session
  where (session.id, session.workspace_id) = (target_session_id, expected_workspace_id) for no key update;
  if found and reviewed.specification_stage_id = expected_stage_id and reviewed.current_stage_id = expected_stage_id then
    perform internal.assert_session_command_access(reviewed.workspace_id, reviewed.factory_id, approver_member_id);
    if reviewed.archived_at is null and reviewed.phase_status = 'awaiting_review'
      and (reviewed.current_artifact_id, reviewed.current_artifact_version) = (expected_artifact_id, expected_version)
      and exists (
        select 1 from public.session_specification_clarifications clarification
        where (clarification.session_id, clarification.artifact_id) = (reviewed.id, expected_artifact_id)
          and clarification.status = 'pending'
      ) then
      raise exception 'Answer the open specification clarification before approving.' using errcode = 'PT423';
    end if;
  end if;
  return query select * from internal.approve_session_stage(target_session_id, expected_workspace_id,
    expected_stage_id, expected_artifact_id, expected_version, approver_member_id, p_agent_model_provider,
    p_agent_model_name, p_run_type, p_expected_review_revision);
end;
$$;
revoke all on function public.approve_session_stage(uuid, uuid, uuid, uuid, integer, uuid, text, text, text, bigint)
  from public, anon, authenticated, service_role;
grant execute on function public.approve_session_stage(uuid, uuid, uuid, uuid, integer, uuid, text, text, text, bigint) to service_role;

create or replace function public.submit_session_follow_up_once(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_artifact_version integer,
  p_expected_stage_id uuid, p_expected_artifact_id uuid, p_feedback_text text,
  p_expected_review_revision bigint default null, p_request_id uuid default null,
  p_selected_thread_ids uuid[] default null, p_agent_model_provider text default null,
  p_agent_model_name text default null, p_run_type text default null, p_requested_by_member_id uuid default null
) returns table(
  session_id uuid, workspace_id uuid, current_stage_id uuid, current_artifact_version integer,
  phase_status public.pipeline_phase_status, rejection_count integer, archived_at timestamptz,
  job_id uuid, run_id uuid, job_created boolean, feedback_batch_id uuid
) language plpgsql security definer set search_path = '' as $$
declare reviewed public.sessions;
begin
  select session.* into reviewed from public.sessions session
  where (session.workspace_id, session.factory_id, session.id) = (p_workspace_id, p_factory_id, p_session_id)
  for no key update;
  if not found then raise exception 'Session not found.' using errcode = 'P0002'; end if;
  perform internal.assert_session_command_access(p_workspace_id, p_factory_id, p_requested_by_member_id);

  if p_expected_review_revision is null and p_request_id is null and p_selected_thread_ids is null then
    if reviewed.current_stage_id = reviewed.specification_stage_id then
      raise exception 'Specification feedback requires an exact review receipt.' using errcode = '22023';
    end if;
    return query select rejected.*, null::uuid
    from public.reject_session_stage(
      p_session_id, p_workspace_id, p_artifact_version, p_feedback_text, p_agent_model_provider,
      p_agent_model_name, p_expected_stage_id, p_expected_artifact_id,
      coalesce(p_run_type, 'project'), p_requested_by_member_id) rejected;
    return;
  end if;

  return query select * from public.submit_artifact_feedback_batch(
    p_session_id, p_workspace_id, p_artifact_version, p_expected_stage_id,
    p_expected_artifact_id, p_expected_review_revision, p_request_id, p_selected_thread_ids,
    p_feedback_text, p_agent_model_provider, p_agent_model_name, p_run_type, p_requested_by_member_id);
end;
$$;

create function public.answer_session_specification_clarification_once(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_actor_member_id uuid, p_clarification_id uuid,
  p_expected_artifact_id uuid, p_expected_artifact_version integer, p_expected_review_revision bigint,
  p_request_id uuid, p_answer_text text,
  p_agent_model_provider text default null, p_agent_model_name text default null, p_run_type text default null
) returns table(clarification_id uuid, feedback_batch_id uuid, job_id uuid, run_id uuid, execution_exhausted boolean, replayed boolean)
language plpgsql security definer set search_path = '' as $$
declare
  session public.sessions;
  clarification public.session_specification_clarifications;
  receipt internal.session_specification_clarification_answers;
  successor record;
  answer text := btrim(p_answer_text, E' \t\r\n');
  feedback text;
  failed_table text;
begin
  if p_request_id is null or p_clarification_id is null or p_expected_artifact_id is null
    or p_expected_artifact_version is null or p_expected_artifact_version <= 0
    or p_expected_review_revision is null or p_expected_review_revision < 0
    or answer is null or length(answer) not between 1 and 2000 then
    raise exception 'An exact clarification, review and bounded answer are required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'specification-answer:' || p_workspace_id::text || ':' || p_actor_member_id::text || ':' || p_request_id::text, 0));
  session := internal.lock_session_conversation(p_workspace_id, p_factory_id, p_session_id, p_actor_member_id);
  select accepted.* into receipt from internal.session_specification_clarification_answers accepted
  where (accepted.workspace_id, accepted.actor_member_id, accepted.request_id) = (p_workspace_id, p_actor_member_id, p_request_id);
  select target.* into clarification from public.session_specification_clarifications target
  where (target.workspace_id, target.factory_id, target.session_id, target.id) =
    (p_workspace_id, p_factory_id, p_session_id, p_clarification_id);
  if receipt.clarification_id is not null then
    if receipt.clarification_id is distinct from clarification.id
      or receipt.expected_review_revision is distinct from p_expected_review_revision
      or (clarification.artifact_id, clarification.artifact_version, clarification.answer_text)
        is distinct from (p_expected_artifact_id, p_expected_artifact_version, answer) then
      raise exception 'This clarification request was already used for different input.' using errcode = 'P0005';
    end if;
    return query select clarification.id, clarification.feedback_batch_id, clarification.successor_job_id,
      clarification.successor_run_id, clarification.execution_exhausted, true;
    return;
  end if;
  if clarification.id is null then raise exception 'Clarification not found.' using errcode = 'PT404'; end if;
  if clarification.status <> 'pending' or session.archived_at is not null or session.phase_status <> 'awaiting_review'
    or session.specification_stage_id is distinct from clarification.stage_id
    or (session.current_stage_id, session.current_artifact_id, session.current_artifact_version, session.artifact_review_revision)
      is distinct from (clarification.stage_id, p_expected_artifact_id, p_expected_artifact_version, p_expected_review_revision)
    or (clarification.artifact_id, clarification.artifact_version) is distinct from (p_expected_artifact_id, p_expected_artifact_version) then
    raise exception 'The specification review changed. Refresh before answering.' using errcode = 'P0003';
  end if;

  feedback := 'Clarification question: ' || clarification.question || E'\n\nClarification answer: ' || answer;
  begin
    select * into strict successor from public.submit_session_follow_up_once(
      session.id, session.workspace_id, session.factory_id, clarification.artifact_version,
      clarification.stage_id, clarification.artifact_id, feedback, p_expected_review_revision, p_request_id,
      '{}'::uuid[], p_agent_model_provider, p_agent_model_name, p_run_type, p_actor_member_id);
  exception when unique_violation then
    get stacked diagnostics failed_table = table_name;
    if failed_table <> 'artifact_feedback_batches' then raise; end if;
    raise exception 'This clarification request was already used for different input.' using errcode = 'P0005';
  end;

  update public.session_specification_clarifications target set
    status = 'answered', answered_at = clock_timestamp(), answered_by_member_id = p_actor_member_id,
    answer_text = answer, feedback_batch_id = successor.feedback_batch_id, successor_job_id = successor.job_id,
    successor_run_id = successor.run_id, execution_exhausted = (successor.job_id is null and successor.run_id is null)
  where target.id = clarification.id returning target.* into strict clarification;
  insert into internal.session_specification_clarification_answers (
    workspace_id, actor_member_id, request_id, clarification_id, expected_review_revision
  ) values (p_workspace_id, p_actor_member_id, p_request_id, clarification.id, p_expected_review_revision);
  return query select clarification.id, clarification.feedback_batch_id, clarification.successor_job_id,
    clarification.successor_run_id, clarification.execution_exhausted, false;
end;
$$;
revoke all on function public.answer_session_specification_clarification_once(
  uuid, uuid, uuid, uuid, uuid, uuid, integer, bigint, uuid, text, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.answer_session_specification_clarification_once(
  uuid, uuid, uuid, uuid, uuid, uuid, integer, bigint, uuid, text, text, text, text
) to service_role;
