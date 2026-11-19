begin;
set local request.jwt.claim.role = 'service_role';
set local wallie.m04_slug = :'workspace_slug';
set local wallie.m04_workspace = :'workspace_id';
set local wallie.m04_factory = :'factory_id';
set local wallie.m04_owner = :'owner_id';
set local wallie.m04_writer_token = :'writer_token_id';
set local wallie.m04_writer_grant = :'writer_grant_id';
set local wallie.m04_witness_grant = :'witness_grant_id';
set local wallie.m04_session = :'session_id';
set local wallie.m04_request = :'request_id';
set local wallie.m04_phase = :'phase';

create temp table authority_proof(result jsonb);
do $$
declare
  workspace uuid := current_setting('wallie.m04_workspace')::uuid;
  factory uuid := current_setting('wallie.m04_factory')::uuid;
  tenant text := current_setting('wallie.m04_slug');
  owner_id uuid := current_setting('wallie.m04_owner')::uuid;
  target_session uuid := nullif(current_setting('wallie.m04_session'),'')::uuid;
  request_key uuid := nullif(current_setting('wallie.m04_request'),'')::uuid;
  phase text := current_setting('wallie.m04_phase');
begin
  if tenant !~ '^m04-qualification-[a-f0-9]{8}$' or not exists (
    select 1 from public.workspaces w join public.factories f on f.workspace_id=w.id
    join public.workspace_members m on m.workspace_id=w.id
    where (w.id,w.slug,f.id,m.user_id,m.role)=(workspace,tenant,factory,owner_id,'owner')
  ) then raise exception 'Unexpected fixture authority.'; end if;

  if phase='revoke' then
    perform public.revoke_factory_machine_token(workspace,factory,owner_id,
      current_setting('wallie.m04_writer_grant')::uuid,current_setting('wallie.m04_writer_token')::uuid);
    insert into authority_proof values (jsonb_build_object('revoked',true));
  elsif phase='expire' then
    -- Fault injection shortens only the independent observer's clock boundary.
    update public.factory_execution_grants grant_row set expires_at=clock_timestamp()-interval '1 millisecond'
    where (grant_row.workspace_id,grant_row.factory_id,grant_row.id)=(workspace,factory,current_setting('wallie.m04_witness_grant')::uuid)
      and grant_row.id<>current_setting('wallie.m04_writer_grant')::uuid
      and grant_row.command_scopes='{sessions:read}'::public.factory_command_scope[];
    if not found then raise exception 'The exact witness grant was not found.'; end if;
    insert into authority_proof values (jsonb_build_object('expired',true));
  elsif phase='audit' then
    insert into authority_proof
    select jsonb_build_object(
      'sessions',(select count(*) from public.sessions session where session.workspace_id=workspace),
      'createReceipts',(select count(*) from internal.session_mutation_receipts receipt where
        (receipt.workspace_id,receipt.factory_id,receipt.session_id,receipt.request_id,receipt.operation)=
        (workspace,factory,target_session,request_key,'create')),
      'conversationCount',(select count(*) from public.session_conversations conversation where
        (conversation.workspace_id,conversation.session_id)=(workspace,target_session)),
      'approvalCount',(select count(*) from public.session_stage_approval_receipts receipt where
        (receipt.workspace_id,receipt.session_id)=(workspace,target_session)),
      'approval',(select jsonb_build_object('artifactId',receipt.artifact_id,'artifactVersion',receipt.artifact_version,
        'stageId',receipt.stage_id,'approverMemberId',receipt.approved_by_member_id)
        from public.session_stage_approval_receipts receipt where
          (receipt.workspace_id,receipt.session_id)=(workspace,target_session) order by receipt.approval_number desc limit 1),
      'runs',(select coalesce(jsonb_agg(jsonb_build_object('id',run.id,'stageId',run.stage_id,'status',run.status,
        'credentialPrincipalId',credential.service_principal_id) order by run.created_at,run.id),'[]')
        from public.agent_runs run left join public.factory_run_credential_receipts credential on credential.run_id=run.id
        where (run.workspace_id,run.session_id)=(workspace,target_session)),
      'personalCredentialRuns',(select count(*) from public.session_attempt_manifests manifest where
        (manifest.workspace_id,manifest.session_id)=(workspace,target_session) and manifest.credential_owner_member_id is not null));
  else
    raise exception 'Unknown fixture authority phase.';
  end if;
end;
$$;
select result from authority_proof;
commit;
