begin;
set local request.jwt.claim.role = 'service_role';
set local wallie.m04_workspace = :'workspace_id';
set local wallie.m04_slug = :'workspace_slug';
set local wallie.m04_factory = :'factory_id';
set local wallie.m04_repository = :'repository_id';
set local wallie.m04_principal = :'writer_principal_id';
set local wallie.m04_session = :'session_id';
set local wallie.m04_job = :'job_id';
set local wallie.m04_stage = :'stage_id';
set local wallie.m04_version = :'expected_version';
set local wallie.m04_markdown = :'markdown';

create temp table publication_result(proof jsonb);
do $$
declare
  control internal.git_continuity_release_control;
  target public.sessions;
  approval public.session_stage_approval_receipts;
  approved_stage_slug text;
  workspace uuid := current_setting('wallie.m04_workspace')::uuid;
  job_id uuid := current_setting('wallie.m04_job')::uuid;
  run_id uuid;
  principal_id uuid;
  claim uuid;
  version_guard integer := current_setting('wallie.m04_version')::integer;
  input_sha text := repeat('a',40);
  markdown text := current_setting('wallie.m04_markdown');
  predecessors jsonb := '[]';
begin
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  if not control.enabled then raise exception 'Enable local continuity before creating fixture sessions.'; end if;
  perform internal.assert_workspace_accepts_work(workspace);
  select session.* into strict target from public.sessions session join public.workspaces tenant on tenant.id=session.workspace_id
  where (session.workspace_id,session.factory_id,session.id,session.github_repository_id,session.current_stage_id,
    session.current_artifact_version)=(workspace,current_setting('wallie.m04_factory')::uuid,
    current_setting('wallie.m04_session')::uuid,current_setting('wallie.m04_repository')::uuid,
    current_setting('wallie.m04_stage')::uuid,version_guard)
    and tenant.slug=current_setting('wallie.m04_slug') and tenant.slug ~ '^m04-qualification-[a-f0-9]{8}$'
    and session.execute_pinned_definition and session.specification_stage_id is not null for no key update of session;

  update public.agent_jobs job set status='running',attempt_count=1,git_continuity_release_revision=control.revision
  where (job.id,job.workspace_id,job.session_id,job.stage_id,job.status)=
    (job_id,target.workspace_id,target.id,target.current_stage_id,'queued');
  if not found then raise exception 'The expected fixture job is not queued.'; end if;
  run_id := public.start_session_job_attempt(job_id,1,target.current_stage_id,version_guard,
    'codex','gpt-5.5','project','wallie/m04-qualification-'||job_id::text);
  if run_id is null or not exists (select 1 from public.pin_session_job_git_input(
    job_id,1,run_id,target.github_repository_id,'main',input_sha)) then
    raise exception 'The fixture attempt did not pin Git source.';
  end if;
  update public.agent_runs run set sandbox_provider='e2b',sandbox_connection_revision=sandbox.connection_revision
  from public.workspace_e2b_sandbox_connections sandbox
  where run.id=run_id and (run.workspace_id,sandbox.workspace_id)=(workspace,workspace);
  if target.current_stage_id<>target.specification_stage_id then
    select receipt.* into strict approval from public.session_stage_approval_receipts receipt
    where (receipt.workspace_id,receipt.session_id,receipt.stage_id)=(workspace,target.id,target.specification_stage_id);
    select stage.slug into strict approved_stage_slug from public.pipeline_stages stage
    where (stage.workspace_id,stage.id)=(workspace,approval.stage_id);
    predecessors := jsonb_build_array(jsonb_build_object('stageId',approval.stage_id,'stageSlug',approved_stage_slug,
      'status','approved','approvalReceiptId',approval.id,'artifactId',approval.artifact_id,
      'artifactVersion',approval.artifact_version,'artifactDigest',approval.artifact_digest));
  end if;
  if not public.pin_session_attempt_manifest(job_id,run_id,1,
    encode(sha256(convert_to('M04 local fixture prompt','UTF8')),'hex'),24,3,input_sha,predecessors,'node',10,null,null) then
    raise exception 'The fixture could not pin the exact attempt manifest.';
  end if;
  select credential.service_principal_id into strict principal_id
  from public.resolve_factory_run_credential(workspace,job_id,run_id,1) credential;
  if principal_id is distinct from current_setting('wallie.m04_principal')::uuid then
    raise exception 'The attempt did not resolve the pinned writer service principal.';
  end if;
  if not public.prepare_session_source_and_checkpoint_publication(run_id,target.github_repository_id,'main',
    input_sha,input_sha,'M04 fixture publication','Synthetic unchanged source','','','',version_guard,markdown) then
    raise exception 'The fixture could not prepare the exact publication.';
  end if;
  claim := public.claim_session_checkpoint_publication(run_id);
  if claim is null or public.adopt_session_checkpoint_publication(run_id,claim) is not true then
    raise exception 'The fixture could not adopt the exact publication.';
  end if;
  insert into publication_result(proof)
  select jsonb_build_object('sessionId',session.id,'jobId',job_id,'runId',run_id,'stageId',session.current_stage_id,
    'artifactId',session.current_artifact_id,'artifactVersion',session.current_artifact_version,
    'reviewRevision',session.artifact_review_revision,'credentialPrincipalId',principal_id)
  from public.sessions session where session.id=target.id;
end;
$$;
select proof from publication_result;
commit;
