-- Inbox is a projection of decisions already owned by the review workbench.
create index sessions_inbox_pending_idx on public.sessions(workspace_id, factory_id)
  where archived_at is null and phase_status = 'awaiting_review' and current_artifact_id is not null;
create index session_conversation_inbox_review_source_idx on public.session_conversation_messages(session_id, artifact_id, sequence desc)
  where kind = 'review_ready';
create index artifact_review_threads_inbox_blockers_idx on public.artifact_review_threads(workspace_id, session_id)
  where kind = 'blocking' and status = 'open';

create function public.get_factory_inbox(
  p_workspace_id uuid,
  p_factory_id uuid default null,
  p_before_at timestamptz default null,
  p_before_artifact_id uuid default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  if (p_before_at is null) <> (p_before_artifact_id is null)
    or (p_before_at is not null and not isfinite(p_before_at)) then
    raise exception 'Invalid Inbox cursor.' using errcode = '22023';
  end if;

  return (
    with actor as materialized (
      select member
      from public.workspace_members member
      join public.workspaces workspace on workspace.id = member.workspace_id
      where workspace.id = p_workspace_id and workspace.deletion_requested_at is null
        and member.user_id = auth.uid() and member.kind = 'human' and member.is_active
    ), factories as materialized (
      select factory.id, factory.name
      from public.factories factory
      where factory.workspace_id = p_workspace_id
        and (p_factory_id is null or factory.id = p_factory_id)
        and internal.can_access_factory(p_workspace_id, factory.id)
    ), current_targets as materialized (
      select session, session.id as session_id, session.number, session.title, factory.id as factory_id,
        factory.name as factory_name, artifact.id as artifact_id, artifact.version,
        artifact.stage_id, artifact.stage_slug, session.artifact_review_revision,
        question.id as clarification_id, coalesce(question.created_at, artifact.created_at) as occurred_at
      from factories factory
      join public.sessions session on (session.workspace_id, session.factory_id) = (p_workspace_id, factory.id)
      join public.session_selected_stages selected_stage
        on (selected_stage.workspace_id, selected_stage.session_id, selected_stage.stage_id) =
          (session.workspace_id, session.id, session.current_stage_id)
      join public.session_artifacts artifact
        on (artifact.workspace_id, artifact.session_id, artifact.id, artifact.stage_id, artifact.version) =
          (session.workspace_id, session.id, session.current_artifact_id, session.current_stage_id, session.current_artifact_version)
      left join public.session_specification_clarifications question
        on (question.workspace_id, question.factory_id, question.session_id, question.stage_id, question.artifact_id, question.artifact_version) =
          (session.workspace_id, session.factory_id, session.id, session.specification_stage_id, artifact.id, artifact.version)
        and question.stage_id = session.current_stage_id and question.status = 'pending'
      cross join actor
      where session.archived_at is null and session.phase_status = 'awaiting_review'
        and session.current_artifact_id is not null
        and case when question.id is not null then true
          else internal.can_review_session_stage(session.id, p_workspace_id, session.current_stage_id, actor.member) end
    ), counts as (
      select count(*) filter (where clarification_id is null) as review,
        count(*) filter (where clarification_id is not null) as clarification
      from current_targets
    ), page as materialized (
      select *
      from current_targets target
      where p_before_at is null or (target.occurred_at, target.artifact_id) < (p_before_at, p_before_artifact_id)
      order by target.occurred_at desc, target.artifact_id desc
      limit 26
    ), items as (
      select coalesce(jsonb_agg(jsonb_build_object(
        'sessionId', target.session_id, 'sessionNumber', target.number, 'title', target.title,
        'factoryId', target.factory_id, 'factoryName', target.factory_name,
        'stageId', target.stage_id, 'stageSlug', target.stage_slug,
        'stageName', coalesce(stage.name, target.stage_slug), 'artifactId', target.artifact_id,
        'artifactVersion', target.version, 'reviewRevision', target.artifact_review_revision,
        'clarificationId', target.clarification_id,
        'kind', case when target.clarification_id is null then 'review' else 'clarification' end,
        'sourceLabel', coalesce(source.author_label, 'Wallie'),
        'occurredAt', target.occurred_at,
        'hasBlockingFeedback', exists (
          select 1 from public.artifact_review_threads thread
          where thread.workspace_id = p_workspace_id and thread.session_id = target.session_id
            and thread.kind = 'blocking' and thread.status = 'open'
        )
      ) order by target.occurred_at desc, target.artifact_id desc), '[]'::jsonb) as payload
      from (
        select * from page order by occurred_at desc, artifact_id desc limit 25
      ) target
      left join lateral internal.session_execution_stages(target.session) stage on stage.id = target.stage_id
      left join lateral (
        select message.author_label from public.session_conversation_messages message
        where message.session_id = target.session_id and message.artifact_id = target.artifact_id
          and message.kind = 'review_ready'
        order by message.sequence desc limit 1
      ) source on true
    )
    select jsonb_build_object(
      'items', items.payload,
      'counts', jsonb_build_object('review', counts.review, 'clarification', counts.clarification),
      'next', case when (select count(*) from page) = 26 then (
        select jsonb_build_object('occurredAt', target.occurred_at, 'artifactId', target.artifact_id)
        from page target order by target.occurred_at desc, target.artifact_id desc offset 24 limit 1
      ) end
    )
    from actor cross join counts cross join items
    where p_factory_id is null or exists (select 1 from factories)
  );
end;
$$;

revoke all on function public.get_factory_inbox(uuid,uuid,timestamptz,uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_factory_inbox(uuid,uuid,timestamptz,uuid) to authenticated;
