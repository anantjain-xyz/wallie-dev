alter table public.factory_scorer_sample_receipts
  add column benchmark_trial_id uuid references public.factory_benchmark_schedule_trials(trial_id) on delete cascade,
  add column benchmark_result_digest text,
  add constraint factory_scorer_sample_receipts_benchmark_source_check check (
    (benchmark_trial_id is null and benchmark_result_digest is null)
    or (benchmark_trial_id is not null and benchmark_result_digest is not null
      and benchmark_result_digest ~ '^[a-f0-9]{64}$' and policy_id is null and outcome = 'sampled')
  );
create unique index factory_scorer_sample_receipts_benchmark_dimension_idx
  on public.factory_scorer_sample_receipts(benchmark_trial_id, scorer_revision_id) where benchmark_trial_id is not null;

-- The runner owns one canonical result. Evaluation projects its exact evidence,
-- regardless of how that runner produced the result.
create view internal.factory_benchmark_evaluation_outputs with (security_invoker = true) as
select scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id, trial.id as trial_id, trial.session_id,
  trial.run_id, trial.attempt_count, trial.actor_user_id, trial.task_id, trial.task_revision_id,
  trial.finished_at, result.result_digest, result.output_commit_sha, result.output_tree_sha,
  result.artifact_markdown, result.artifact_sha256, result.validation,
  frozen.candidate_key, frozen.repetition, candidate.definition_revision_id
from public.factory_benchmark_schedule_trials scheduled
join public.factory_benchmark_trials trial on (trial.workspace_id, trial.factory_id, trial.id, trial.run_id) =
  (scheduled.workspace_id, scheduled.factory_id, scheduled.trial_id, scheduled.run_id)
join public.factory_benchmark_trial_results result on (result.workspace_id, result.factory_id, result.trial_id, result.run_id) =
  (trial.workspace_id, trial.factory_id, trial.id, trial.run_id)
join public.factory_benchmark_experiment_trials frozen on
  (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.trial_id, frozen.task_revision_id) =
  (scheduled.workspace_id, scheduled.factory_id, scheduled.experiment_id, scheduled.trial_id, trial.task_revision_id)
join public.factory_benchmark_experiment_candidates candidate on
  (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.candidate_key) =
  (frozen.workspace_id, frozen.factory_id, frozen.experiment_id, frozen.candidate_key)
join public.agent_runs run on (run.workspace_id, run.session_id, run.id, run.attempt_count) =
  (trial.workspace_id, trial.session_id, trial.run_id, trial.attempt_count)
where trial.status = 'success' and run.status = 'success' and frozen.replay_eligibility = 'eligible';

revoke all on internal.factory_benchmark_evaluation_outputs from public, anon, authenticated, service_role;

create function internal.factory_benchmark_evaluation_source_available(
  output internal.factory_benchmark_evaluation_outputs
) returns boolean language plpgsql set search_path = '' as $$
declare original public.sessions;
begin
  if not internal.can_read_factory_evaluation_receipts(output.workspace_id, output.factory_id, output.actor_user_id) then
    return false;
  end if;
  select source.* into original
  from public.factory_benchmark_task_inputs input
  join public.sessions source on (source.workspace_id, source.factory_id, source.id, source.factory_definition_revision_id) =
    (input.workspace_id, input.factory_id, input.source_session_id, input.definition_revision_id)
  join public.agent_runs run on (run.workspace_id, run.session_id, run.id, run.agent_job_id, run.attempt_count) =
    (input.workspace_id, input.source_session_id, input.source_run_id, input.source_job_id, input.source_attempt_count)
  where (input.workspace_id, input.factory_id, input.task_id) = (output.workspace_id, output.factory_id, output.task_id)
    and source.execution_purpose = 'production'
    and not exists (select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id) = (output.workspace_id, output.factory_id)
        and erasure.session_id in (source.id, output.session_id))
  for key share of source, run nowait;
  if not found then return false; end if;

  if not original.execute_pinned_definition and exists (select 1 from public.session_factory_admission_inputs admission
    where (admission.workspace_id, admission.factory_id, admission.session_id) =
      (original.workspace_id, original.factory_id, original.id) and admission.execution_grant_id is not null)
  then return false; end if;
  perform internal.recheck_session_execution_grant(original);
  return true;
exception when insufficient_privilege or no_data_found or lock_not_available then
  return false;
end;
$$;

create function internal.factory_benchmark_evaluation_evidence(
  output internal.factory_benchmark_evaluation_outputs, p_definition jsonb, p_include_content boolean
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(descriptor.value order by required.position)
    filter (where descriptor.value is not null), '[]'::jsonb)
  from jsonb_array_elements_text(p_definition->'requiredEvidence') with ordinality as required(kind, position)
  cross join lateral (
    select case required.kind
      when 'artifact' then case when octet_length(output.artifact_markdown) between 1 and 98304 then
        jsonb_build_object('kind', 'artifact', 'id', output.trial_id)
        || case when p_include_content then jsonb_build_object('content_md', output.artifact_markdown) else '{}'::jsonb end
      end
      when 'validation_report' then case when jsonb_typeof(output.validation) = 'object'
        and output.validation->>'commitSha' = output.output_commit_sha
        and output.validation->>'treeSha' = output.output_tree_sha
        and octet_length(output.validation::text) between 1 and 98304 then
        jsonb_build_object('kind', 'validation_report', 'id', output.trial_id)
        || case when p_include_content then jsonb_build_object('source', 'benchmark_result',
          'content_text', output.validation::text, 'sha256', encode(sha256(convert_to(output.validation::text, 'UTF8')), 'hex'))
          else '{}'::jsonb end
      end
    end as value
  ) descriptor;
$$;

create function public.reconcile_factory_benchmark_evaluations(p_limit integer default 25)
returns integer language plpgsql security definer set search_path = '' set lock_timeout = '100ms' as $$
declare
  candidate record;
  output internal.factory_benchmark_evaluation_outputs;
  sample_id uuid;
  admitted integer := 0;
begin
  perform internal.assert_checkpoint_publication_service();
  if not coalesce(p_limit between 1 and 100, false) then
    raise exception 'Invalid benchmark evaluation batch size.' using errcode = '22023';
  end if;

  for candidate in
    select result.workspace_id, result.factory_id, result.experiment_id, result.trial_id, result.run_id,
      dimension.scorer_revision_id, ready.evidence
    from internal.factory_benchmark_evaluation_outputs result
    join public.factory_benchmark_schedules schedule on
      (schedule.workspace_id, schedule.factory_id, schedule.experiment_id) =
      (result.workspace_id, result.factory_id, result.experiment_id)
    join public.factory_benchmark_evaluation_dimensions dimension on
      (dimension.workspace_id, dimension.factory_id, dimension.experiment_id) =
      (result.workspace_id, result.factory_id, result.experiment_id)
    join public.factory_scorer_revisions scorer on (scorer.workspace_id, scorer.factory_id, scorer.id) =
      (dimension.workspace_id, dimension.factory_id, dimension.scorer_revision_id)
    cross join lateral (select internal.factory_benchmark_evaluation_evidence(result, scorer.definition, false) as evidence) ready
    where schedule.state = 'active'
      and jsonb_array_length(ready.evidence) = jsonb_array_length(scorer.definition->'requiredEvidence')
      and not exists (select 1 from public.factory_scorer_sample_receipts existing
        where (existing.benchmark_trial_id, existing.scorer_revision_id) = (result.trial_id, dimension.scorer_revision_id))
    order by result.finished_at, result.trial_id, dimension.scorer_revision_id
    limit p_limit
  loop
    begin
      perform 1 from public.workspaces workspace
      where workspace.id = candidate.workspace_id and workspace.deletion_requested_at is null for share skip locked;
      if not found then continue; end if;
      perform 1 from public.factories factory
      where (factory.workspace_id, factory.id, factory.status) = (candidate.workspace_id, candidate.factory_id, 'active')
      for share skip locked;
      if not found then continue; end if;

      insert into public.factory_evaluation_lanes(workspace_id) values (candidate.workspace_id)
      on conflict (workspace_id) do nothing;
      perform 1 from public.factory_evaluation_lanes lane
      where lane.workspace_id = candidate.workspace_id for share skip locked;
      if not found then continue; end if;
      perform 1 from public.factory_benchmark_schedules schedule
      where (schedule.workspace_id, schedule.factory_id, schedule.experiment_id, schedule.state) =
        (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, 'active')
      for share skip locked;
      if not found then continue; end if;

      select * into output from internal.factory_benchmark_evaluation_outputs exact
      where (exact.workspace_id, exact.factory_id, exact.experiment_id, exact.trial_id, exact.run_id) =
        (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.trial_id, candidate.run_id);
      if not found then continue; end if;

      -- A sample contains references only. The judge rechecks the source
      -- before reading content or authorizing spend.

      insert into public.factory_scorer_sample_receipts (
        workspace_id, factory_id, definition_revision_id, scorer_revision_id, session_id, run_id,
        attempt_count, run_finished_at, target_commit_sha, outcome, missing_evidence, evidence,
        benchmark_trial_id, benchmark_result_digest
      ) values (
        output.workspace_id, output.factory_id, output.definition_revision_id, candidate.scorer_revision_id,
        output.session_id, output.run_id, output.attempt_count, output.finished_at, output.output_commit_sha,
        'sampled', '{}', candidate.evidence, output.trial_id, output.result_digest
      ) on conflict (benchmark_trial_id, scorer_revision_id) where benchmark_trial_id is not null do nothing
      returning id into sample_id;
      if not found then continue; end if;

      insert into public.factory_evaluation_jobs (
        workspace_id, factory_id, session_id, run_id, scorer_revision_id, sample_receipt_id, target_commit_sha
      ) values (
        output.workspace_id, output.factory_id, output.session_id, output.run_id,
        candidate.scorer_revision_id, sample_id, output.output_commit_sha
      );
      admitted := admitted + 1;
    exception when lock_not_available then
      continue;
    end;
  end loop;
  return admitted;
end;
$$;

revoke all on function internal.factory_benchmark_evaluation_source_available(internal.factory_benchmark_evaluation_outputs),
  internal.factory_benchmark_evaluation_evidence(internal.factory_benchmark_evaluation_outputs,jsonb,boolean),
  public.reconcile_factory_benchmark_evaluations(integer) from public, anon, authenticated, service_role;
grant execute on function public.reconcile_factory_benchmark_evaluations(integer) to service_role;
