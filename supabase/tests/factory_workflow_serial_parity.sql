begin;
create extension if not exists pgtap with schema extensions;
select plan(3);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.op657_id(slot integer) returns uuid language sql immutable as $$
  select ('65700000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

do $$ begin
  if exists (select 1 from public.agent_jobs where status in ('queued','started','running')) then
    raise exception 'Use an idle disposable database for serial qualification.';
  end if;
end; $$;
select public.set_git_continuity_release(true, revision, 'Serial qualification fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into auth.users(id,email) values
  (pg_temp.op657_id(1), 'op657-serial-owner@example.test'),
  (pg_temp.op657_id(2), 'op657-serial-reviewer@example.test'),
  (pg_temp.op657_id(3), 'op657-serial-outsider@example.test');
insert into public.workspaces(id,slug,name)
values (pg_temp.op657_id(11),'op657-serial-qualification','Serial qualification');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.op657_id(21), pg_temp.op657_id(11), pg_temp.op657_id(1), 'human','owner'),
  (pg_temp.op657_id(22), pg_temp.op657_id(11), pg_temp.op657_id(2), 'human','member'),
  (pg_temp.op657_id(23), pg_temp.op657_id(11), pg_temp.op657_id(3), 'human','member');
insert into public.user_codex_credentials(user_id,credential_type,encrypted_credential)
values (pg_temp.op657_id(1),'platform_api_key','synthetic-ciphertext');

create temp table qualification_scope as select workspace_id, id as factory_id
from public.factories where workspace_id = pg_temp.op657_id(11) and is_default;
insert into public.pipelines(id,workspace_id,factory_id,name,is_default)
select pg_temp.op657_id(31), workspace_id, factory_id, 'Serial qualification', true from qualification_scope;
insert into public.pipeline_stages(id,pipeline_id,workspace_id,position,slug,name,
  prompt_template_md,anyone_can_approve,approver_member_ids)
values
  (pg_temp.op657_id(32),pg_temp.op657_id(31),pg_temp.op657_id(11),1,'plan','Plan',
    'Plan {{session.prompt}}.',false,array[pg_temp.op657_id(22)]),
  (pg_temp.op657_id(33),pg_temp.op657_id(31),pg_temp.op657_id(11),2,'build','Build',
    'Build from {{artifact.previousStages.plan}}.',false,array[pg_temp.op657_id(22)]);
insert into public.github_installations(id,workspace_id,installation_id,installation_url,app_id,target_type,target_name,permissions)
values (pg_temp.op657_id(34),pg_temp.op657_id(11),65700034,'https://github.test/installations/65700034',
  657000,'Organization','Qualification','{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id,workspace_id,factory_id,github_installation_id,repo_id,name,full_name,private,html_url,default_branch)
select pg_temp.op657_id(35),workspace_id,factory_id,pg_temp.op657_id(34),65700035,
  'serial-qualification','fixture/serial-qualification',true,'https://github.test/fixture/serial-qualification','main'
from qualification_scope;

\ir fixtures/factory_workflow_serial_compiled.psql

create function pg_temp.prepare_serial_attempt(p_job_id uuid, p_base_sha text, p_output_sha text, p_artifact text)
returns uuid language plpgsql as $$
declare claimed public.agent_jobs; session_row public.sessions; started uuid;
begin
  select * into strict claimed from public.claim_next_agent_job(false, 8, 'node');
  if (claimed.id, claimed.attempt_count) is distinct from (p_job_id, 1) then
    raise exception 'Canonical claim selected an unexpected job or attempt.';
  end if;
  select * into strict session_row from public.sessions where id=claimed.session_id;
  started := public.start_session_job_attempt(claimed.id,claimed.attempt_count,
    session_row.current_stage_id,session_row.current_artifact_version,
    'codex','gpt-5.5','code','wallie/serial-qualification-'||claimed.id);
  if started is null then raise exception 'Canonical attempt start was rejected.'; end if;
  perform public.pin_session_job_git_input(claimed.id,1,started,pg_temp.op657_id(35),'main',p_base_sha);
  if not found then raise exception 'The exact Git input was not pinned.'; end if;
  if not public.prepare_session_source_and_checkpoint_publication(started,pg_temp.op657_id(35),
    'main',p_base_sha,p_output_sha,'Serial qualification','Serial qualification','',
    encode(sha256(convert_to('synthetic source at '||p_output_sha,'UTF8')),'hex'),
    encode(convert_to('synthetic source at '||p_output_sha,'UTF8'),'base64'),
    session_row.current_artifact_version,p_artifact,null,12,4) then
    raise exception 'Exact source and artifact were not prepared.';
  end if;
  return started;
end;
$$;

create function pg_temp.qualify_serial_case(p_mode text)
returns jsonb language plpgsql as $$
declare
  admitted record;
  pin public.session_factory_admission_inputs;
  bundle record;
  session_row public.sessions;
  approved record;
  rejected record;
  canceled record;
  run_plan uuid;
  run_build uuid;
  run_retry uuid;
  initial_lease uuid;
  active_lease uuid;
  attempt_ref text;
  predecessor_text text;
  denied_reviewer boolean := false;
  recovered boolean;
  duplicate boolean;
  late_attempt_refused boolean;
begin
  perform set_config('request.jwt.claim.sub',pg_temp.op657_id(1)::text,true);
  select * into strict admitted from public.create_session_with_first_job(pg_temp.op657_id(11),pg_temp.op657_id(21),
    p_mode||' serial qualification','Prepare the same change.','codex','gpt-5.5',null,null,pg_temp.op657_id(35));
  if (select execute_pinned_definition from public.sessions where id=admitted.session_id) is distinct from (p_mode='compiled') then
    raise exception 'The requested serial mode was not admitted: %',p_mode;
  end if;

  if p_mode='compiled' then
    select * into strict pin from public.session_factory_admission_inputs where session_id=admitted.session_id;
    select * into strict bundle from compiled_serial_bundle;
    perform public.start_factory_workflow_execution(pin.session_id,pin.workspace_id,pin.factory_id,pin.definition_revision_id,
      pin.definition_digest,bundle.workflow_json,bundle.workflow_digest);
    if not found then raise exception 'The actual compiler projection was not enrolled.'; end if;
  end if;

  run_plan := pg_temp.prepare_serial_attempt(admitted.job_id,repeat('a',40),repeat('b',40),'Plan the same change.');
  initial_lease := public.claim_session_checkpoint_publication(run_plan);
  if initial_lease is null then raise exception 'Plan publication could not be leased.'; end if;
  update public.session_checkpoint_publications set lease_expires_at=clock_timestamp()-interval '1 second'
  where run_id=run_plan;
  active_lease := public.claim_session_checkpoint_publication(run_plan);
  select retained_ref into strict attempt_ref from public.session_checkpoint_publications where run_id=run_plan;
  recovered := active_lease is not null and active_lease <> initial_lease
    and not public.adopt_session_checkpoint_publication(run_plan,initial_lease,attempt_ref,repeat('b',40));
  if not public.adopt_session_checkpoint_publication(run_plan,active_lease,attempt_ref,repeat('b',40)) then
    raise exception 'The recovered publication could not be adopted.';
  end if;
  duplicate := public.adopt_session_checkpoint_publication(run_plan,active_lease,attempt_ref,repeat('b',40));
  select * into strict session_row from public.sessions where id=admitted.session_id;
  if session_row.phase_status<>'awaiting_review' then raise exception 'Plan was not submitted for review.'; end if;

  perform set_config('request.jwt.claim.sub',pg_temp.op657_id(3)::text,true);
  begin
    perform public.approve_session_stage(session_row.id,session_row.workspace_id,session_row.current_stage_id,
      session_row.current_artifact_id,session_row.current_artifact_version,pg_temp.op657_id(23),
      'codex','gpt-5.5','code',session_row.artifact_review_revision);
    denied_reviewer := not found;
  exception when insufficient_privilege then denied_reviewer := true;
  end;
  perform set_config('request.jwt.claim.sub',pg_temp.op657_id(2)::text,true);
  select * into strict approved from public.approve_session_stage(session_row.id,session_row.workspace_id,session_row.current_stage_id,
    session_row.current_artifact_id,session_row.current_artifact_version,pg_temp.op657_id(22),
    'codex','gpt-5.5','code',session_row.artifact_review_revision);
  select artifact_text into strict predecessor_text from public.load_attempt_predecessor_approvals(session_row.id);
  if approved.current_stage_slug <> 'build' then raise exception 'Approval did not advance to Build.'; end if;

  run_build := pg_temp.prepare_serial_attempt(approved.job_id,repeat('b',40),repeat('c',40),'Review the first build.');
  active_lease := public.claim_session_checkpoint_publication(run_build);
  select retained_ref into strict attempt_ref from public.session_checkpoint_publications where run_id=run_build;
  if active_lease is null or not public.adopt_session_checkpoint_publication(run_build,active_lease,attempt_ref,repeat('c',40))
    then raise exception 'Build adoption was rejected.'; end if;
  select * into strict session_row from public.sessions where id=admitted.session_id;
  select * into strict rejected from public.reject_session_stage(session_row.id,session_row.workspace_id,
    session_row.current_artifact_version,'Revise the same build.','codex','gpt-5.5',
    session_row.current_stage_id,session_row.current_artifact_id,'code',pg_temp.op657_id(22));
  if rejected.job_id is null or rejected.job_id=approved.job_id then
    raise exception 'Rejection did not create a fresh Build job.';
  end if;

  run_retry := pg_temp.prepare_serial_attempt(rejected.job_id,repeat('c',40),repeat('d',40),'Late canceled build.');
  active_lease := public.claim_session_checkpoint_publication(run_retry);
  select retained_ref into strict attempt_ref from public.session_checkpoint_publications where run_id=run_retry;
  select * into strict canceled from public.cancel_session_job_attempts(admitted.session_id,session_row.workspace_id,
    'Qualification cancellation',run_retry);
  late_attempt_refused := not public.adopt_session_checkpoint_publication(run_retry,active_lease,attempt_ref,repeat('d',40));
  perform public.release_session_checkpoint_publication(run_retry,active_lease);

  return jsonb_build_object(
    'modeAdmitted',true,
    'workerRecovery',recovered,
    'duplicateCompletion',duplicate and 1=(select count(*) from public.session_git_checkpoints where run_id=run_plan),
    'reviewerDenied',denied_reviewer,
    'approvalSource',predecessor_text,
    'buildStage',approved.current_stage_slug,
    'retryOwnsCheckpoint',exists(select 1 from public.session_job_git_inputs
      where job_id=rejected.job_id and input_sha=repeat('c',40) and source_checkpoint_run_id=run_build),
    'cancelReturnsExactAttempts',canceled.job_ids=array[rejected.job_id] and canceled.run_ids=array[run_retry],
    'lateAttemptRefused',late_attempt_refused,
    'acceptedHeadUnchanged',(select checkpoint_run_id=run_build from public.session_git_heads where session_id=admitted.session_id),
    'acceptedPrTargetUnchanged',(select desired_checkpoint_run_id=run_build from public.session_pr_sync where session_id=admitted.session_id),
    'staleIntentRetained',exists(select 1 from public.session_checkpoint_publications where run_id=run_retry and status='stale'),
    'canceledUsageRetained',exists(select 1 from public.agent_runs
      where id=run_retry and status='canceled' and input_tokens=12 and output_tokens=4),
    'phase',(select phase_status from public.sessions where id=admitted.session_id)
  );
end;
$$;

create temp table qualification_result(mode text primary key, trace jsonb);
insert into qualification_result values ('legacy', pg_temp.qualify_serial_case('legacy'));
with revision as (
  insert into public.factory_definition_revisions(id,workspace_id,factory_id,schema_version,
    definition_json,canonical_digest,created_by)
  select pg_temp.op657_id(41),workspace_id,factory_id,1,bundle.definition_json,bundle.definition_digest,pg_temp.op657_id(21)
  from qualification_scope cross join compiled_serial_bundle bundle
  returning id,workspace_id,factory_id,created_by
)
insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
select workspace_id,factory_id,id,1,created_by from revision;
insert into qualification_result values ('compiled', pg_temp.qualify_serial_case('compiled'));

select is((select trace from qualification_result where mode='legacy'),
  (select trace from qualification_result where mode='compiled'),
  'legacy and compiled modes produce the same durable trace');
select ok(trace @> '{"modeAdmitted":true,"workerRecovery":true,"duplicateCompletion":true,
    "reviewerDenied":true,"approvalSource":"Plan the same change.","buildStage":"build",
    "retryOwnsCheckpoint":true,"cancelReturnsExactAttempts":true,"lateAttemptRefused":true,
    "acceptedHeadUnchanged":true,"acceptedPrTargetUnchanged":true,"staleIntentRetained":true,
    "canceledUsageRetained":true,"phase":"rejected"}'::jsonb,
  mode||' preserves exact review, retry, cancellation, publication, lineage and usage obligations')
from qualification_result order by mode;
select * from finish();
rollback;
