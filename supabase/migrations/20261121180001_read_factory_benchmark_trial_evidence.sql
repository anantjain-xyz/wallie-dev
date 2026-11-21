-- A historical evidence read retains the original grant's identity and live
-- resource checks, with no active-factory requirement for reading history.
create function internal.can_read_factory_benchmark_source(p_session public.sessions)
returns boolean language plpgsql set search_path = '' as $$
declare
  definition jsonb;
  admission public.session_factory_admission_inputs;
  grant_row public.factory_execution_grants;
begin
  select * into admission from public.session_factory_admission_inputs recorded
  where (recorded.workspace_id,recorded.factory_id,recorded.session_id) =
    (p_session.workspace_id,p_session.factory_id,p_session.id);
  if not p_session.execute_pinned_definition then return admission.execution_grant_id is null; end if;

  definition := internal.pinned_session_execution_definition(p_session);
  if not coalesce(definition ? 'executionGrant',false) then return admission.execution_grant_id is null; end if;
  if admission.execution_grant_id is null
    or (admission.definition_revision_id,admission.github_repository_id,admission.execution_policy_revision_id) is distinct from
      (p_session.factory_definition_revision_id,p_session.github_repository_id,p_session.execution_policy_revision_id)
    or ((definition#>>'{executionGrant,id}'),(definition#>>'{executionGrant,version}')) is distinct from
      (admission.execution_grant_id::text,admission.execution_grant_version::text)
  then return false; end if;

  select * into grant_row from public.factory_execution_grants current_grant
  where (current_grant.workspace_id,current_grant.factory_id,current_grant.id) =
    (p_session.workspace_id,p_session.factory_id,admission.execution_grant_id)
  for share nowait;
  if not found or grant_row.revoked_at is not null or grant_row.expires_at <= clock_timestamp()
    or (grant_row.version,grant_row.service_principal_id,grant_row.budget_payer_member_id,
        grant_row.github_repository_id,grant_row.execution_policy_revision_id) is distinct from
      (admission.execution_grant_version,admission.credential_owner_service_principal_id,admission.budget_payer_member_id,
        admission.github_repository_id,admission.execution_policy_revision_id)
    or (array(select id::uuid from jsonb_array_elements_text(definition->'readContextRepositoryIds') ids(id))
        <@ grant_row.read_context_repository_ids) is not true
    or (array(select tool from jsonb_array_elements_text(definition->'toolIds') ids(tool)) <@ grant_row.tool_ids) is not true
    or internal.factory_execution_scope_is_current(p_session.workspace_id,p_session.factory_id,grant_row.github_repository_id,
      array(select id::uuid from jsonb_array_elements_text(definition->'readContextRepositoryIds') ids(id)),
      grant_row.execution_policy_revision_id,grant_row.budget_payer_member_id) is not true
  then return false; end if;

  if admission.invoking_actor_service_principal_id is null then
    perform internal.assert_factory_grant_invoker(p_session.workspace_id,p_session.factory_id,admission.invoking_actor_member_id);
  elsif admission.invoking_actor_service_principal_id is distinct from p_session.creator_service_principal_id
    or admission.invoking_actor_service_principal_id is distinct from grant_row.service_principal_id
  then return false; end if;
  return grant_row.expires_at > clock_timestamp();
exception when insufficient_privilege or no_data_found or lock_not_available or sqlstate 'PT409' or sqlstate 'PT422' then
  return false;
end;
$$;

create function internal.factory_benchmark_evidence_transcript_expired_at(run public.agent_runs)
returns timestamptz language sql stable set search_path = '' as $$
  select coalesce(expired.expired_at, case when run.status in ('success','error','canceled') and
    coalesce(run.finished_at,run.updated_at) <= statement_timestamp() - internal.run_retention_duration(policy.transcript_days)
    then coalesce(run.finished_at,run.updated_at) + internal.run_retention_duration(policy.transcript_days) end)
  from (values (run.workspace_id)) scoped(workspace_id)
  left join public.workspace_run_retention policy on policy.workspace_id = scoped.workspace_id
  left join public.agent_run_transcript_expirations expired on (expired.workspace_id,expired.run_id) = (run.workspace_id,run.id);
$$;

create function internal.factory_benchmark_evidence_owner(run public.agent_runs,p_commit_sha text,p_tree_sha text)
returns jsonb language sql stable set search_path = '' as $$
  select case when run.id is not null then jsonb_build_object('sessionId',run.session_id,'runId',run.id,
    'jobId',run.agent_job_id,'attemptCount',run.attempt_count,'runStatus',run.status,
    'commitSha',p_commit_sha,'treeSha',p_tree_sha) end;
$$;

-- Judge explanations can contain original evidence text. Return them only
-- when every exact evidence reference still resolves against the adopted result.
create function internal.read_factory_benchmark_trial_score_evidence(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_trial_id uuid,p_disposition text,
  p_result public.factory_benchmark_trial_results,p_withheld boolean
) returns jsonb language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('scorerRevisionId',revision.id,'scorerId',scorer.id,'name',scorer.name,
    'revisionNumber',revision.revision_number,'status',case
      when exact.job_status = 'canceled' or p_disposition = 'canceled' then 'skipped'
      when evidence.availability = 'withheld' then 'unavailable'
      when exact.job_status in ('succeeded','failed') then case
        when receipt.block_reason is not null or receipt.reason in ('evidence_unavailable','profile_unavailable') then 'unavailable'
        else coalesce(receipt.status,'unavailable') end
      when p_disposition in ('failed','timed_out','unavailable','excluded') then 'unavailable'
      when p_disposition = 'succeeded' and (p_result.trial_id is null or plan.budget_limit_usd = 0 or schedule.evaluation_reserve_usd = 0)
        then 'unavailable'
      else 'pending' end,
    'reason',coalesce(receipt.block_reason,receipt.reason,case when evidence.availability = 'withheld' then 'evidence_withheld' end),
    'score',receipt.result->'score','explanation',case when evidence.availability = 'available' then receipt.explanation end,
    'evidenceAvailability',evidence.availability,
    'evidenceLocations',case when evidence.availability = 'available' then coalesce((
      select jsonb_agg(jsonb_build_object('kind',citation.value#>>'{reference,kind}','location',citation.value->'location') order by citation.position)
      from jsonb_array_elements(receipt.evidence_locations) with ordinality citation(value,position)
      where citation.value#>>'{reference,id}' = p_trial_id::text
        and citation.value#>>'{reference,kind}' in ('artifact','validation_report')
        and citation.value#>>'{location,kind}' in ('whole','lines')
    ),'[]'::jsonb) else '[]'::jsonb end) order by revision.id),'[]'::jsonb)
  from public.factory_benchmark_evaluation_dimensions selected
  join public.factory_scorer_revisions revision on (revision.workspace_id,revision.factory_id,revision.id) =
    (selected.workspace_id,selected.factory_id,selected.scorer_revision_id)
  join public.factory_scorers scorer on (scorer.workspace_id,scorer.factory_id,scorer.id) =
    (revision.workspace_id,revision.factory_id,revision.scorer_id)
  join public.factory_benchmark_evaluation_plans plan on (plan.workspace_id,plan.factory_id,plan.experiment_id) =
    (selected.workspace_id,selected.factory_id,selected.experiment_id)
  left join public.factory_benchmark_schedules schedule on (schedule.workspace_id,schedule.factory_id,schedule.experiment_id) =
    (plan.workspace_id,plan.factory_id,plan.experiment_id)
  left join lateral (
    select job.id,job.status as job_status,sample.id as sample_id from public.factory_scorer_sample_receipts sample
    join public.factory_evaluation_jobs job on (job.workspace_id,job.factory_id,job.session_id,job.run_id,
        job.scorer_revision_id,job.sample_receipt_id,job.target_commit_sha) =
      (sample.workspace_id,sample.factory_id,sample.session_id,sample.run_id,sample.scorer_revision_id,sample.id,sample.target_commit_sha)
      and job.source_attempt_id is null
    where (sample.workspace_id,sample.factory_id,sample.benchmark_trial_id,sample.run_id,sample.scorer_revision_id,
        sample.benchmark_result_digest,sample.target_commit_sha) =
      (p_workspace_id,p_factory_id,p_trial_id,p_result.run_id,revision.id,p_result.result_digest,p_result.output_commit_sha)
  ) exact on true
  left join lateral (
    select settled.status,settled.reason,settled.result,settled.explanation,settled.evidence_locations,blocked.reason as block_reason
    from public.factory_evaluation_receipts settled
    left join internal.factory_benchmark_evaluation_blocks blocked on blocked.attempt_id = settled.attempt_id
    where (settled.workspace_id,settled.factory_id,settled.job_id,settled.sample_receipt_id,settled.run_id,
        settled.scorer_revision_id,settled.target_commit_sha) =
      (p_workspace_id,p_factory_id,exact.id,exact.sample_id,p_result.run_id,revision.id,p_result.output_commit_sha)
    order by settled.attempt_number desc limit 1
  ) receipt on exact.job_status in ('succeeded','failed','canceled')
  cross join lateral (select case
    when p_withheld then 'withheld'
    when receipt.block_reason is not null or receipt.result is null or jsonb_array_length(receipt.result->'evidence') = 0
      then 'unavailable'
    when exists (select 1 from jsonb_array_elements(receipt.result->'evidence') linked(value)
      where linked.value->>'id' is distinct from p_trial_id::text or not coalesce(case linked.value->>'kind'
        when 'artifact' then octet_length(p_result.artifact_markdown) between 1 and 98304
          and p_result.artifact_sha256 = encode(sha256(convert_to(p_result.artifact_markdown,'UTF8')),'hex')
        when 'validation_report' then jsonb_typeof(p_result.validation) = 'object'
          and octet_length(p_result.validation::text) between 1 and 98304
          and p_result.validation->>'commitSha' = p_result.output_commit_sha
          and p_result.validation->>'treeSha' = p_result.output_tree_sha
        else false end,false)) then 'unavailable'
    else 'available' end as availability) evidence
  where (selected.workspace_id,selected.factory_id,selected.experiment_id) = (p_workspace_id,p_factory_id,p_experiment_id);
$$;

create function public.read_factory_benchmark_trial_evidence(
  p_workspace_id uuid,p_factory_id uuid,p_experiment_id uuid,p_trial_id uuid,p_actor_user_id uuid
) returns jsonb language plpgsql security definer set search_path = '' set timezone = 'UTC' as $$
declare
  actor_member_id uuid;
  cell record;
  facts record;
  pin public.factory_benchmark_task_inputs;
  source_match record;
  source_run public.agent_runs;
  source_checkpoint public.session_git_checkpoints;
  source_plan public.session_validation_plans;
  output_run public.agent_runs;
  output_result public.factory_benchmark_trial_results;
  output_plan public.session_validation_plans;
  delta internal.factory_benchmark_trial_diffs;
  source_availability text := 'unavailable';
  output_availability text := 'unavailable';
  withheld boolean := false;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  if actor_member_id is null then raise exception 'Benchmark evidence is unavailable.' using errcode = '42501'; end if;

  select frozen as identity,task as revision,source_task.source_run_id,source_task.source_session_id,candidate as configuration,
    suite.suite_id,suite.id as suite_revision_id,suite.revision_number as suite_revision_number,suite.name as suite_name,
    experiment.policy_revision_id,experiment.policy_digest
  into cell from public.factory_benchmark_experiment_trials frozen
  join public.factory_benchmark_experiments experiment on (experiment.workspace_id,experiment.factory_id,experiment.id) =
    (frozen.workspace_id,frozen.factory_id,frozen.experiment_id)
  join public.factory_benchmark_suite_revisions suite on (suite.workspace_id,suite.factory_id,suite.id) =
    (experiment.workspace_id,experiment.factory_id,experiment.suite_revision_id)
  join public.factory_benchmark_task_revisions task on (task.workspace_id,task.factory_id,task.task_id,task.id) =
    (frozen.workspace_id,frozen.factory_id,frozen.task_id,frozen.task_revision_id)
  join public.factory_benchmark_tasks source_task on (source_task.workspace_id,source_task.factory_id,source_task.id) =
    (task.workspace_id,task.factory_id,task.task_id)
  join public.factory_benchmark_experiment_candidates candidate on (candidate.workspace_id,candidate.factory_id,
      candidate.experiment_id,candidate.candidate_key) =
    (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.candidate_key)
  where (frozen.workspace_id,frozen.factory_id,frozen.experiment_id,frozen.trial_id) =
    (p_workspace_id,p_factory_id,p_experiment_id,p_trial_id);
  if not found then raise exception 'Benchmark trial is unavailable.' using errcode = 'P0002'; end if;

  select input.* into pin from public.factory_benchmark_task_inputs input
  where (input.workspace_id,input.factory_id,input.task_id,input.source_session_id,input.source_run_id) =
    (p_workspace_id,p_factory_id,(cell.identity).task_id,cell.source_session_id,cell.source_run_id);
  begin
    select owner as session,run as attempt into source_match
    from public.sessions owner join public.agent_runs run on (run.workspace_id,run.session_id,run.id,run.agent_job_id,run.attempt_count) =
      (pin.workspace_id,pin.source_session_id,pin.source_run_id,pin.source_job_id,pin.source_attempt_count)
    where (owner.workspace_id,owner.factory_id,owner.id,owner.factory_definition_revision_id) =
      (pin.workspace_id,pin.factory_id,pin.source_session_id,pin.definition_revision_id)
      and owner.execution_purpose = 'production' and run.status in ('success','error','canceled') and run.finished_at is not null
    for share of owner,run nowait;
    if found then
      if exists (select 1 from public.session_retained_content_erasures erased
        where (erased.workspace_id,erased.factory_id,erased.session_id) = (p_workspace_id,p_factory_id,pin.source_session_id))
        or not internal.can_read_factory_benchmark_source(source_match.session)
      then
        source_availability := 'withheld';
      else
        source_availability := 'available';
        source_run := source_match.attempt;
        select checkpoint.* into source_checkpoint from public.session_git_checkpoints checkpoint
        where (checkpoint.workspace_id,checkpoint.session_id,checkpoint.run_id,checkpoint.job_id,checkpoint.attempt_count,checkpoint.repository_id) =
          (p_workspace_id,pin.source_session_id,pin.source_run_id,pin.source_job_id,pin.source_attempt_count,pin.repository_id);
        select plan.* into source_plan from public.session_validation_plans plan
        where (plan.workspace_id,plan.session_id,plan.run_id,plan.job_id,plan.attempt_count,plan.repository_id,plan.commit_sha) =
          (p_workspace_id,pin.source_session_id,pin.source_run_id,pin.source_job_id,pin.source_attempt_count,pin.repository_id,source_checkpoint.output_sha);
      end if;
    end if;
  exception when lock_not_available then
    source_availability := 'unavailable';
  end;

  -- Resolve the public disposition and exact evidence in one statement snapshot.
  select disposition,reason,admitted,started,run as attempted_run,result as adopted_result,
    (output_session.id is not null and erased.session_id is not null) as output_erased
  into facts from internal.factory_benchmark_comparison_trial_facts(p_workspace_id,p_factory_id,p_experiment_id,statement_timestamp()) fact
  left join public.factory_benchmark_trials trial on (trial.workspace_id,trial.factory_id,trial.id,trial.run_id) =
    (p_workspace_id,p_factory_id,fact.trial_id,fact.run_id)
  left join public.sessions output_session on (output_session.workspace_id,output_session.factory_id,output_session.id) =
    (trial.workspace_id,trial.factory_id,trial.session_id) and output_session.execution_purpose = 'benchmark'
  left join public.agent_runs run on (run.workspace_id,run.session_id,run.agent_job_id,run.id,run.attempt_count) =
    (trial.workspace_id,output_session.id,trial.job_id,trial.run_id,trial.attempt_count) and run.started_at is not null
  left join public.factory_benchmark_trial_results result on (result.workspace_id,result.factory_id,result.trial_id,result.run_id) =
    (trial.workspace_id,trial.factory_id,trial.id,run.id) and run.status = 'success' and trial.status = 'success'
    and result.input_commit_sha = pin.checkout_sha
  left join public.session_retained_content_erasures erased on (erased.workspace_id,erased.factory_id,erased.session_id) =
    (output_session.workspace_id,output_session.factory_id,output_session.id)
  where fact.trial_id = p_trial_id;

  withheld := source_availability = 'withheld' or coalesce(facts.output_erased,false);
  if withheld then
    output_availability := 'withheld';
  elsif source_availability = 'available' then
    output_run := facts.attempted_run;
    output_result := facts.adopted_result;
    if output_result.trial_id is not null then
      output_availability := 'available';
      select plan.* into output_plan from public.session_validation_plans plan
      where (plan.workspace_id,plan.session_id,plan.run_id,plan.job_id,plan.attempt_count,plan.repository_id,
          plan.commit_sha,plan.validation_tree_sha) =
        (p_workspace_id,output_run.session_id,output_run.id,output_run.agent_job_id,output_run.attempt_count,pin.repository_id,
          output_result.output_commit_sha,output_result.output_tree_sha);
      select staged.* into delta from internal.factory_benchmark_trial_diffs staged
      where (staged.workspace_id,staged.factory_id,staged.trial_id,staged.job_id,staged.run_id,staged.attempt_count,
          staged.input_commit_sha,staged.input_tree_sha,staged.output_commit_sha,staged.output_tree_sha) =
        (p_workspace_id,p_factory_id,p_trial_id,output_run.agent_job_id,output_run.id,output_run.attempt_count,
          output_result.input_commit_sha,output_result.input_tree_sha,output_result.output_commit_sha,output_result.output_tree_sha);
    end if;
  end if;
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is distinct from actor_member_id
  then raise exception 'Benchmark evidence is unavailable.' using errcode = '42501'; end if;

  return jsonb_build_object('workspaceId',p_workspace_id,'factoryId',p_factory_id,'experimentId',p_experiment_id,
    'suite',jsonb_build_object('id',cell.suite_id,'revisionId',cell.suite_revision_id,'revisionNumber',cell.suite_revision_number,'name',cell.suite_name),
    'trial',jsonb_build_object('id',p_trial_id,'repetition',(cell.identity).repetition,'seed',(cell.identity).seed,'timeoutMs',(cell.identity).timeout_ms,
      'eligibility',(cell.identity).replay_eligibility,'eligibilityReason',(cell.identity).eligibility_reason,
      'status',facts.disposition,'reason',facts.reason,'admitted',facts.admitted,'started',facts.started),
    'task',jsonb_build_object('id',(cell.revision).task_id,'revisionId',(cell.revision).id,'revisionNumber',(cell.revision).revision_number,
      'name',(cell.revision).name,'acceptanceCriteria',case when source_availability = 'available'
        then left((cell.revision).acceptance_criteria,20000) end,
      'acceptanceTruncated',source_availability = 'available' and char_length((cell.revision).acceptance_criteria) > 20000,
      'tags',(cell.revision).tags),
    'candidate',jsonb_build_object('key',(cell.configuration).candidate_key,'position',(cell.configuration).comparison_position,
      'definitionRevisionId',(cell.configuration).definition_revision_id,'definitionDigest',(cell.configuration).definition_digest,
      'harness',(cell.configuration).harness,'model',(cell.configuration).model,'workerRuntime',(cell.configuration).worker_runtime,
      'sandboxProvider',(cell.configuration).sandbox_provider),
    'frozenInputs',jsonb_build_object('policyRevisionId',cell.policy_revision_id,'policyDigest',cell.policy_digest,
      'checkoutSha',pin.checkout_sha,'inputSha',pin.input_sha,'sourceDefinitionRevisionId',pin.definition_revision_id,
      'sourceDefinitionDigest',pin.definition_digest,'contextManifestSha256',pin.context_manifest_sha256),
    'source',jsonb_build_object('availability',source_availability,'owner',internal.factory_benchmark_evidence_owner(source_run,
      source_checkpoint.output_sha,source_plan.validation_tree_sha),'mediaPlanMatched',source_plan.run_id is not null,
      'transcriptExpiredAt',internal.factory_benchmark_evidence_transcript_expired_at(source_run)),
    'output',jsonb_build_object('availability',output_availability,'owner',internal.factory_benchmark_evidence_owner(output_run,
      output_result.output_commit_sha,output_result.output_tree_sha),'mediaPlanMatched',output_plan.run_id is not null,
      'transcriptExpiredAt',internal.factory_benchmark_evidence_transcript_expired_at(output_run),
      'inputCommitSha',output_result.input_commit_sha,'inputTreeSha',output_result.input_tree_sha,'resultDigest',output_result.result_digest,
      'validation',case when (output_result.validation->>'commitSha',output_result.validation->>'treeSha') =
          (output_result.output_commit_sha,output_result.output_tree_sha)
        then jsonb_build_object('key',output_result.validation->>'key','status',output_result.validation->>'status',
          'commitSha',output_result.output_commit_sha,'treeSha',output_result.output_tree_sha) end),
    'diff',jsonb_build_object('availability',case when withheld then 'withheld' when delta.trial_id is not null then 'available' else 'unavailable' end,
      'patch',delta.patch,'sha256',delta.patch_sha256),
    'scores',internal.read_factory_benchmark_trial_score_evidence(p_workspace_id,p_factory_id,p_experiment_id,p_trial_id,
      facts.disposition,output_result,withheld));
end;
$$;

revoke all on function internal.can_read_factory_benchmark_source(public.sessions),
  internal.factory_benchmark_evidence_transcript_expired_at(public.agent_runs),
  internal.factory_benchmark_evidence_owner(public.agent_runs,text,text),
  internal.read_factory_benchmark_trial_score_evidence(uuid,uuid,uuid,uuid,text,public.factory_benchmark_trial_results,boolean),
  public.read_factory_benchmark_trial_evidence(uuid,uuid,uuid,uuid,uuid)
from public, anon, authenticated, service_role;
grant execute on function public.read_factory_benchmark_trial_evidence(uuid,uuid,uuid,uuid,uuid) to service_role;
