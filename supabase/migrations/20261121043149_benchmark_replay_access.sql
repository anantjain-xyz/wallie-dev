-- Reuse the normal execution grant decision for the original source session.
-- Replay admission reads the frozen task revision, never the latest revision.
create function public.assert_factory_benchmark_replay_access(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_task_revision_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
declare source public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);

  select session.* into source
  from public.factory_benchmark_task_revisions revision
  join public.factory_benchmark_task_inputs input
    on (input.workspace_id, input.factory_id, input.task_id) =
       (revision.workspace_id, revision.factory_id, revision.task_id)
  join public.sessions session
    on (session.workspace_id, session.factory_id, session.id, session.factory_definition_revision_id) =
       (input.workspace_id, input.factory_id, input.source_session_id, input.definition_revision_id)
  join public.agent_runs run
    on (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count) =
       (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count)
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_workspace_id, p_factory_id, p_task_revision_id)
    and revision.replay_eligibility = 'eligible'
    and run.status in ('success', 'error', 'canceled') and run.finished_at is not null
    and not exists (
      select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
        (session.workspace_id, session.factory_id, session.id)
    )
  for key share of session, run nowait;
  if not found then
    raise exception 'The benchmark source or task revision is unavailable.' using errcode = 'P0002';
  end if;

  if not source.execute_pinned_definition and exists (
    select 1 from public.session_factory_admission_inputs admission
    where (admission.workspace_id, admission.factory_id, admission.session_id) =
      (source.workspace_id, source.factory_id, source.id)
      and admission.execution_grant_id is not null
  ) then
    raise exception 'The benchmark source execution authority is unavailable.' using errcode = '42501';
  end if;
  perform internal.recheck_session_execution_grant(source);
  return true;
exception when lock_not_available then
  raise exception 'The benchmark source is changing. Retry after the change finishes.' using errcode = 'PT409';
end;
$$;

revoke all on function public.assert_factory_benchmark_replay_access(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.assert_factory_benchmark_replay_access(uuid, uuid, uuid, uuid)
  to service_role;
