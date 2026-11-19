create type public.factory_session_read_operation as enum ('sessions', 'session', 'conversation', 'runs', 'run', 'artifact');

create index sessions_factory_writer_number_idx
  on public.sessions(workspace_id, factory_id, github_repository_id, number desc)
  where github_repository_id is not null;

-- This view only supplies eligibility for the private projection. A legacy
-- configured repository is insufficient without durable Git lineage.
create view internal.factory_session_read_owners with (security_invoker = true) as
  select session as admitted_session, session.id, session.workspace_id, session.factory_id, session.github_repository_id, session.number
  from public.sessions session
  where session.github_repository_id is not null and (
    session.execute_pinned_definition or exists (
      select 1 from public.session_git_roots root
      where (root.session_id, root.workspace_id, root.repository_id) =
        (session.id, session.workspace_id, session.github_repository_id)
    )
  );
revoke all on internal.factory_session_read_owners from public, anon, authenticated, service_role;

-- The checkpoint is the durable producer of the artifact. Match the exact
-- attempt, job, stage and repository even when a later run exists.
create function internal.factory_session_artifact_producer(p_artifact public.session_artifacts, p_repository_id uuid)
returns table(run_id uuid, attempt_count integer, commit_sha text)
language sql stable set search_path = '' as $$
  select run.id, checkpoint.attempt_count, checkpoint.output_sha
  from public.session_git_checkpoints checkpoint
  join public.agent_runs run on
    (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count) =
    (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id, checkpoint.attempt_count)
  where (checkpoint.artifact_id, checkpoint.session_id, checkpoint.workspace_id, checkpoint.repository_id) =
    (p_artifact.id, p_artifact.session_id, p_artifact.workspace_id, p_repository_id)
    and run.stage_id = p_artifact.stage_id
    and run.status = 'success';
$$;

create function internal.factory_session_read_summary(p_session public.sessions)
returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_session.id,
    'number', p_session.number,
    'title', left(p_session.title, 200),
    'status', p_session.phase_status,
    'archivedAt', p_session.archived_at,
    'createdAt', p_session.created_at,
    'updatedAt', p_session.updated_at,
    'currentStageId', p_session.current_stage_id,
    'specificationStageId', p_session.specification_stage_id,
    'currentRunId', (
      select run.id from public.agent_runs run
      where (run.session_id, run.workspace_id, run.stage_id) =
        (p_session.id, p_session.workspace_id, p_session.current_stage_id)
      order by run.created_at desc, run.id desc limit 1
    ),
    'review', (
      select jsonb_build_object(
        'stageId', artifact.stage_id,
        'stageSlug', artifact.stage_slug,
        'artifactId', artifact.id,
        'artifactVersion', artifact.version,
        'reviewRevision', p_session.artifact_review_revision,
        'runId', producer.run_id,
        'attemptCount', producer.attempt_count,
        'checkpointRunId', producer.run_id,
        'clarification', case when clarification.id is not null then jsonb_build_object(
          'id', clarification.id, 'question', clarification.question
        ) end
      )
      from public.session_artifacts artifact
      cross join lateral internal.factory_session_artifact_producer(artifact, p_session.github_repository_id) producer
      join public.session_git_heads head on
        (head.session_id, head.workspace_id, head.checkpoint_run_id) =
        (p_session.id, p_session.workspace_id, producer.run_id)
      left join public.session_specification_clarifications clarification on
        (clarification.workspace_id, clarification.factory_id, clarification.session_id, clarification.stage_id,
          clarification.artifact_id, clarification.artifact_version, clarification.run_id, clarification.attempt_count) =
        (p_session.workspace_id, p_session.factory_id, p_session.id, artifact.stage_id,
          artifact.id, artifact.version, producer.run_id, producer.attempt_count)
        and clarification.status = 'pending' and p_session.specification_stage_id = artifact.stage_id
      where p_session.archived_at is null and p_session.phase_status = 'awaiting_review'
        and (artifact.id, artifact.session_id, artifact.workspace_id, artifact.stage_id, artifact.version) =
        (p_session.current_artifact_id, p_session.id, p_session.workspace_id,
          p_session.current_stage_id, p_session.current_artifact_version)
    )
  );
$$;

create function internal.factory_session_read_run(
  p_run public.agent_runs, p_session_number integer, p_repository_id uuid
) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object(
    'id', p_run.id,
    'sessionId', p_run.session_id,
    'sessionNumber', p_session_number,
    'stageId', p_run.stage_id,
    'stageSlug', p_run.stage_slug,
    'stageName', left(p_run.stage_name, 128),
    'status', p_run.status,
    'attemptCount', p_run.attempt_count,
    'createdAt', p_run.created_at,
    'startedAt', p_run.started_at,
    'completedAt', p_run.finished_at,
    'artifactId', artifact.id,
    'artifactCoverage', case when artifact.id is not null then 'available' else 'unavailable' end,
    'transcriptAvailability', case when expires.run_id is not null then 'expired' else 'not_exposed' end
  )
  from (select 1) anchor
  left join lateral (
    select result.id
    from public.session_git_checkpoints checkpoint
    join public.session_artifacts result on
      (result.id, result.workspace_id, result.session_id, result.stage_id) =
      (checkpoint.artifact_id, checkpoint.workspace_id, checkpoint.session_id, p_run.stage_id)
    where (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id,
      checkpoint.attempt_count, checkpoint.repository_id) =
      (p_run.id, p_run.workspace_id, p_run.session_id, p_run.agent_job_id, p_run.attempt_count, p_repository_id)
      and p_run.status = 'success'
      and jsonb_typeof(result.artifact_json) = 'string'
      and octet_length(result.artifact_json #>> '{}') <= 1048576
  ) artifact on true
  left join public.agent_run_transcript_expirations expires on
    (expires.run_id, expires.workspace_id) = (p_run.id, p_run.workspace_id);
$$;

create function internal.factory_session_read_source(p_source public.session_conversation_sources)
returns jsonb
language sql stable strict set search_path = '' as $$
  select jsonb_build_object(
    'id', p_source.id, 'provider', p_source.provider, 'label', p_source.label, 'url', p_source.source_url
  );
$$;

-- Run the whole projection in one read snapshot, after the outer operation
-- has validated and locked the current authority. Every nested read starts
-- with an exact workspace, factory and writable repository session owner.
create function internal.project_factory_session_read(
  p_workspace_id uuid, p_factory_id uuid, p_repository_id uuid, p_operation public.factory_session_read_operation,
  p_session_id uuid, p_run_id uuid, p_artifact_id uuid, p_limit integer, p_before_session_number integer,
  p_before_created_at timestamptz, p_before_id uuid, p_conversation_direction text, p_conversation_sequence integer
) returns jsonb
language plpgsql stable set search_path = '' set plan_cache_mode = force_custom_plan as $$
declare
  target public.sessions;
  result jsonb;
  workspace_slug text;
  forward boolean := p_conversation_direction = 'after';
begin
  if p_session_id is not null then
    select (session.admitted_session).* into target from internal.factory_session_read_owners session
    where (session.id, session.workspace_id, session.factory_id, session.github_repository_id) =
      (p_session_id, p_workspace_id, p_factory_id, p_repository_id);
    if not found then return jsonb_build_object('status', 'not_found'); end if;
  end if;

  case p_operation
    when 'sessions' then
      with candidates as materialized (
        select session.admitted_session as item, session.number from internal.factory_session_read_owners session
        where (session.workspace_id, session.factory_id, session.github_repository_id) =
          (p_workspace_id, p_factory_id, p_repository_id)
          and (p_before_session_number is null or session.number < p_before_session_number)
        order by session.number desc limit p_limit + 1
      ), page as materialized (
        select * from candidates order by number desc limit p_limit
      )
      select jsonb_build_object(
        'items', coalesce(jsonb_agg(internal.factory_session_read_summary(item) order by number desc), '[]'::jsonb),
        'nextCursor', case when (select count(*) from candidates) > p_limit then jsonb_build_object('number', min(number)) end
      ) into result from page;

    when 'session' then
      result := internal.factory_session_read_summary(target);

    when 'conversation' then
      if not exists (
        select 1 from public.session_conversations conversation
        where (conversation.session_id, conversation.workspace_id, conversation.factory_id) =
          (target.id, target.workspace_id, target.factory_id)
      ) then return jsonb_build_object('status', 'unavailable'); end if;

      with candidates as materialized (
        (select message.* from public.session_conversation_messages message
        where not forward and (message.session_id, message.workspace_id, message.factory_id) =
          (target.id, target.workspace_id, target.factory_id)
          and (p_conversation_sequence is null or message.sequence < p_conversation_sequence)
        order by message.sequence desc limit p_limit + 1)
        union all
        (select message.* from public.session_conversation_messages message
        where forward and (message.session_id, message.workspace_id, message.factory_id) =
          (target.id, target.workspace_id, target.factory_id)
          and (p_conversation_sequence is null or message.sequence > p_conversation_sequence)
        order by message.sequence limit p_limit + 1)
      ), page as materialized (
        select * from candidates
        order by case when forward then sequence else -sequence end limit p_limit
      )
      select jsonb_build_object(
        'sessionId', target.id, 'sessionNumber', target.number,
        'items', coalesce(jsonb_agg(jsonb_build_object(
          'sequence', page.sequence,
          'kind', page.kind,
          'authorKind', page.author_kind,
          'authorLabel', page.author_label,
          'createdAt', page.created_at,
          'bodyMarkdown', page.body_md,
          'bodyTruncated', page.body_truncated,
          'runId', page.run_id,
          'attemptCount', page.attempt_count,
          'artifactId', page.artifact_id,
          'source', case when source.id is not null then internal.factory_session_read_source(source) end
        ) order by page.sequence), '[]'::jsonb),
        'nextCursor', case when (select count(*) from candidates) > p_limit
          then jsonb_build_object('sequence', case when forward then max(page.sequence) else min(page.sequence) end) end,
        'sourceLinks', (
          select coalesce(jsonb_agg(internal.factory_session_read_source(links.item) order by links.created_at, links.id), '[]'::jsonb)
          from (
            select source as item, source.created_at, source.id from public.session_conversation_sources source
            where (source.session_id, source.workspace_id, source.factory_id) = (target.id, target.workspace_id, target.factory_id)
            order by source.created_at, source.id limit 50
          ) links
        )
      ) into result from page
      left join public.session_conversation_sources source on
        (source.id, source.session_id, source.workspace_id, source.factory_id) =
        (page.source_id, page.session_id, page.workspace_id, page.factory_id);

    when 'runs' then
      with candidates as materialized (
        select run as item, run.created_at, run.id, session.number
        from public.agent_runs run
        join internal.factory_session_read_owners session on (session.id, session.workspace_id) = (run.session_id, run.workspace_id)
        where (session.workspace_id, session.factory_id, session.github_repository_id) =
          (p_workspace_id, p_factory_id, p_repository_id)
          and (p_session_id is null or run.session_id = p_session_id)
          and (p_before_created_at is null or (run.created_at, run.id) < (p_before_created_at, p_before_id))
        order by run.created_at desc, run.id desc limit p_limit + 1
      ), page as materialized (
        select * from candidates order by created_at desc, id desc limit p_limit
      )
      select jsonb_build_object(
        'items', coalesce(jsonb_agg(internal.factory_session_read_run(item, number, p_repository_id)
          order by created_at desc, id desc), '[]'::jsonb),
        'nextCursor', case when (select count(*) from candidates) > p_limit then (
          select jsonb_build_object('createdAt', tail.created_at, 'id', tail.id)
          from page tail order by tail.created_at, tail.id limit 1
        ) end
      ) into result from page;

    when 'run' then
      select internal.factory_session_read_run(run, session.number, p_repository_id) into result
      from public.agent_runs run
      join internal.factory_session_read_owners session on (session.id, session.workspace_id) = (run.session_id, run.workspace_id)
      where run.id = p_run_id and (session.workspace_id, session.factory_id, session.github_repository_id) =
        (p_workspace_id, p_factory_id, p_repository_id)
        and (p_session_id is null or run.session_id = p_session_id);

    when 'artifact' then
      select case when artifact.stage_id is not null and producer.run_id is not null
        and jsonb_typeof(artifact.artifact_json) = 'string' and octet_length(artifact.artifact_json #>> '{}') <= 1048576
        then jsonb_build_object(
          'id', artifact.id,
          'sessionId', session.id,
          'sessionNumber', session.number,
          'stageId', artifact.stage_id,
          'stageSlug', artifact.stage_slug,
          'version', artifact.version,
          'createdAt', artifact.created_at,
          'bodyMarkdown', artifact.artifact_json #>> '{}',
          'provenance', jsonb_build_object(
            'runId', producer.run_id, 'attemptCount', producer.attempt_count,
            'checkpointRunId', producer.run_id, 'commitSha', producer.commit_sha
          )
        ) end into result
      from public.session_artifacts artifact
      join internal.factory_session_read_owners session on
        (session.id, session.workspace_id) = (artifact.session_id, artifact.workspace_id)
      left join lateral internal.factory_session_artifact_producer(artifact, p_repository_id) producer on true
      where artifact.id = p_artifact_id
        and (session.workspace_id, session.factory_id, session.github_repository_id) = (p_workspace_id, p_factory_id, p_repository_id)
        and (p_session_id is null or artifact.session_id = p_session_id)
        and (p_run_id is null or producer.run_id = p_run_id);
      if found and result is null then return jsonb_build_object('status', 'unavailable'); end if;
  end case;

  if result is null then return jsonb_build_object('status', 'not_found'); end if;
  select workspace.slug into strict workspace_slug from public.workspaces workspace where workspace.id = p_workspace_id;
  return jsonb_build_object('status', 'ok', 'workspaceSlug', workspace_slug, 'data', result);
end;
$$;

revoke all on function internal.factory_session_artifact_producer(public.session_artifacts, uuid),
  internal.factory_session_read_summary(public.sessions),
  internal.factory_session_read_run(public.agent_runs, integer, uuid),
  internal.factory_session_read_source(public.session_conversation_sources),
  internal.project_factory_session_read(uuid, uuid, uuid, public.factory_session_read_operation,
    uuid, uuid, uuid, integer, integer, timestamptz, uuid, text, integer)
  from public, anon, authenticated, service_role;

create function public.read_factory_session_command(
  p_workspace_id uuid, p_factory_id uuid, p_credential_kind public.factory_command_credential_kind,
  p_credential_id uuid, p_credential_digest text, p_request_id uuid, p_request_hash text, p_surface public.factory_command_surface,
  p_admission_id uuid, p_lease_id uuid, p_operation public.factory_session_read_operation,
  p_session_id uuid default null, p_run_id uuid default null, p_artifact_id uuid default null,
  p_limit integer default 25, p_before_session_number integer default null, p_before_created_at timestamptz default null,
  p_before_id uuid default null, p_conversation_direction text default 'before', p_conversation_sequence integer default null
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  accepted internal.factory_command_admissions;
  writer_repository_id uuid;
  result jsonb;
begin
  if p_operation is null or p_limit is null or p_limit not between 1 and 50
    or (p_operation in ('session', 'conversation') and p_session_id is null)
    or (p_operation = 'sessions' and p_session_id is not null)
    or (p_operation = 'run' and p_run_id is null)
    or (p_operation not in ('run', 'artifact') and p_run_id is not null)
    or ((p_operation = 'artifact') <> (p_artifact_id is not null))
    or (p_before_session_number is not null and (p_before_session_number < 1 or p_operation <> 'sessions'))
    or ((p_before_created_at is null) <> (p_before_id is null))
    or (p_before_created_at is not null and (not isfinite(p_before_created_at) or p_operation <> 'runs'))
    or p_conversation_direction is null or p_conversation_direction not in ('before', 'after')
    or (p_operation <> 'conversation' and (p_conversation_direction <> 'before' or p_conversation_sequence is not null))
    or p_conversation_sequence < 0 then
    raise exception 'Invalid factory session read parameters.' using errcode = '22023';
  end if;

  accepted := internal.require_factory_command(
    p_workspace_id, p_factory_id, p_credential_kind, p_credential_id, p_credential_digest, 'sessions:read',
    p_request_id, p_request_hash, p_surface, p_admission_id, p_lease_id);
  -- require_factory_command already locked and validated this exact grant and
  -- the repository recorded as its writable authority.
  select approved.github_repository_id into strict writer_repository_id
  from public.factory_execution_grants approved
  where (approved.workspace_id, approved.factory_id, approved.id, approved.version, approved.service_principal_id) =
    (accepted.workspace_id, accepted.factory_id, accepted.execution_grant_id,
      accepted.execution_grant_version, accepted.service_principal_id);

  result := internal.project_factory_session_read(
    accepted.workspace_id, accepted.factory_id, writer_repository_id, p_operation, p_session_id, p_run_id, p_artifact_id,
    p_limit, p_before_session_number, p_before_created_at, p_before_id, p_conversation_direction, p_conversation_sequence);
  if result->>'status' = 'ok' then
    perform internal.record_factory_command_use(p_admission_id, p_lease_id);
  end if;
  return result;
end;
$$;
revoke all on function public.read_factory_session_command(
  uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text, public.factory_command_surface,
  uuid, uuid, public.factory_session_read_operation, uuid, uuid, uuid, integer, integer, timestamptz, uuid, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_session_command(
  uuid, uuid, public.factory_command_credential_kind, uuid, text, uuid, text, public.factory_command_surface,
  uuid, uuid, public.factory_session_read_operation, uuid, uuid, uuid, integer, integer, timestamptz, uuid, text, integer)
  to service_role;
