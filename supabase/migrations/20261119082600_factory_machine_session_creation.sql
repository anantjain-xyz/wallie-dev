-- Service-principal attribution survives the credential and transport permit
-- that admitted the request. Human member fields retain their existing meaning.
alter table public.sessions add column creator_service_principal_id uuid;
alter table public.sessions add constraint sessions_creation_actor_exclusive
  check (creator_service_principal_id is null or (creator_member_id is null and execute_pinned_definition));

alter table public.session_factory_admission_inputs
  add column invoking_actor_service_principal_id uuid,
  drop constraint factory_admission_execution_attribution;
alter table public.session_factory_admission_inputs
  add constraint factory_admission_execution_attribution check (
    (
      execution_grant_id is null and execution_grant_version is null
      and credential_owner_service_principal_id is null and invoking_actor_service_principal_id is null
      and (
        (invoking_actor_member_id is null and credential_owner_member_id is null and budget_payer_member_id is null)
        or (invoking_actor_member_id is not null
          and credential_owner_member_id is not distinct from invoking_actor_member_id
          and budget_payer_member_id is not distinct from invoking_actor_member_id)
      )
    ) or (
      execution_grant_id is not null and execution_grant_version is not null and execution_grant_version > 0
      and (invoking_actor_member_id is not null) <> (invoking_actor_service_principal_id is not null)
      and credential_owner_member_id is null and credential_owner_service_principal_id is not null
      and (invoking_actor_service_principal_id is null
        or invoking_actor_service_principal_id = credential_owner_service_principal_id)
      and budget_payer_member_id is not null and execution_policy_revision_id is not null
    )
  );

create function internal.preserve_session_service_creator()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.creator_service_principal_id is distinct from old.creator_service_principal_id then
    raise exception 'Session service creator is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.preserve_session_service_creator() from public, anon, authenticated, service_role;
create trigger preserve_session_service_creator before update of creator_service_principal_id on public.sessions
  for each row execute function internal.preserve_session_service_creator();

alter table public.session_conversation_messages add column originating_service_principal_id uuid;
alter table public.session_conversation_messages add constraint conversation_service_author_consistent check (
  (author_kind = 'service') = (originating_service_principal_id is not null)
  and (originating_service_principal_id is null or originating_member_id is null)
);


create or replace function internal.guard_session_factory_admission_inputs()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  session public.sessions;
  definition jsonb;
  execution_grant public.factory_execution_grants;
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Session factory admission inputs are immutable.' using errcode = '23514';
  end if;
  select s.* into session
  from public.sessions s
  join public.factory_definition_activations a
    on (a.workspace_id, a.factory_id, a.activation_number, a.revision_id) =
       (s.workspace_id, new.factory_id, new.activation_number, s.factory_definition_revision_id)
  join public.factory_definition_revisions r
    on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where (s.id, s.workspace_id, s.factory_definition_revision_id) =
    (new.session_id, new.workspace_id, new.definition_revision_id)
    and r.canonical_digest = new.definition_digest
    and (not s.execute_pinned_definition or (
      new.original_title is not null
      and new.factory_id = s.factory_id
      and new.github_repository_id is not distinct from s.github_repository_id
      and new.execution_policy_revision_id is not distinct from s.execution_policy_revision_id
    ));
  if not found then
    raise exception 'Factory admission inputs must match the session pin.' using errcode = '23514';
  end if;

  -- Derive every identity from the authorized session and immutable definition.
  -- The caller cannot supply an invoker, credential owner, payer or grant pin.
  new.execution_grant_id := null;
  new.execution_grant_version := null;
  new.invoking_actor_member_id := null;
  new.invoking_actor_service_principal_id := null;
  new.credential_owner_member_id := null;
  new.credential_owner_service_principal_id := null;
  new.budget_payer_member_id := null;
  if not session.execute_pinned_definition then return new; end if;

  definition := internal.pinned_session_execution_definition(session);
  new.invoking_actor_member_id := session.creator_member_id;
  new.invoking_actor_service_principal_id := session.creator_service_principal_id;
  if definition ? 'executionGrant' then
    execution_grant := internal.resolve_definition_execution_grant(session.workspace_id, session.factory_id,
      definition, session.github_repository_id, session.execution_policy_revision_id);
    if session.creator_service_principal_id is null then
      perform internal.assert_factory_grant_invoker(session.workspace_id, session.factory_id, session.creator_member_id);
    elsif session.creator_service_principal_id is distinct from execution_grant.service_principal_id then
      raise exception 'The session service creator does not match the approved execution grant.' using errcode = '42501';
    end if;
    new.execution_grant_id := execution_grant.id;
    new.execution_grant_version := execution_grant.version;
    new.credential_owner_service_principal_id := execution_grant.service_principal_id;
    new.budget_payer_member_id := execution_grant.budget_payer_member_id;
  else
    if session.creator_service_principal_id is not null then
      raise exception 'A machine-created session requires service execution.' using errcode = '42501';
    end if;
    new.credential_owner_member_id := session.creator_member_id;
    new.budget_payer_member_id := session.creator_member_id;
  end if;
  return new;
end;
$$;

create or replace function internal.recheck_session_execution_grant(p_session public.sessions)
returns void language plpgsql set search_path = '' as $$
declare
  definition jsonb;
  admission public.session_factory_admission_inputs;
  execution_grant public.factory_execution_grants;
begin
  if not p_session.execute_pinned_definition then return; end if;
  definition := internal.pinned_session_execution_definition(p_session);
  if not (definition ? 'executionGrant') then return; end if;
  select * into admission from public.session_factory_admission_inputs receipt
  where (receipt.session_id, receipt.workspace_id, receipt.factory_id, receipt.definition_revision_id) =
    (p_session.id, p_session.workspace_id, p_session.factory_id, p_session.factory_definition_revision_id);
  if not found or admission.execution_grant_id is null
    or admission.github_repository_id is distinct from p_session.github_repository_id
    or admission.execution_policy_revision_id is distinct from p_session.execution_policy_revision_id then
    raise exception 'The session service execution receipt is unavailable.' using errcode = '42501';
  end if;
  execution_grant := internal.resolve_definition_execution_grant(p_session.workspace_id, p_session.factory_id,
    definition, admission.github_repository_id, admission.execution_policy_revision_id);
  if admission.invoking_actor_service_principal_id is null then
    perform internal.assert_factory_grant_invoker(p_session.workspace_id, p_session.factory_id, admission.invoking_actor_member_id);
  elsif admission.invoking_actor_service_principal_id is distinct from p_session.creator_service_principal_id
    or admission.invoking_actor_service_principal_id is distinct from execution_grant.service_principal_id then
    raise exception 'The session service execution receipt is unavailable.' using errcode = '42501';
  end if;
  if (admission.execution_grant_id, admission.execution_grant_version,
      admission.credential_owner_service_principal_id, admission.budget_payer_member_id) is distinct from
    (execution_grant.id, execution_grant.version,
      execution_grant.service_principal_id, execution_grant.budget_payer_member_id) then
    raise exception 'The session service execution receipt is unavailable.' using errcode = '42501';
  end if;
end;
$$;

create or replace function internal.append_session_conversation_message(
  p_session public.sessions, p_message public.session_conversation_messages, p_receipt_key text
) returns table(sequence integer, replayed boolean)
language plpgsql set search_path = '' as $$
declare prior public.session_conversation_messages; appended_sequence integer;
begin
  for prior in
    select message.* from public.session_conversation_messages message
    where message.session_id = p_session.id and (
      message.sequence = (select receipt.sequence from internal.session_conversation_message_receipts receipt
        where receipt.session_id = p_session.id and receipt.receipt_key = p_receipt_key) or
      (message.source_id, message.external_message_id) = (p_message.source_id, p_message.external_message_id))
  loop
    if (prior.kind, prior.author_kind, prior.originating_member_id, prior.originating_service_principal_id,
        prior.run_id, prior.attempt_count,
        prior.artifact_id, prior.feedback_batch_id, prior.source_id, prior.external_message_id, prior.external_actor_id,
        prior.body_md, prior.body_truncated)
      is distinct from
      (p_message.kind, p_message.author_kind, p_message.originating_member_id, p_message.originating_service_principal_id,
        p_message.run_id, p_message.attempt_count,
        p_message.artifact_id, p_message.feedback_batch_id, p_message.source_id, p_message.external_message_id,
        p_message.external_actor_id, p_message.body_md, p_message.body_truncated) then
      raise exception 'This message receipt was already used for different input.' using errcode = 'P0005';
    end if;
    appended_sequence := prior.sequence;
  end loop;
  if appended_sequence is not null then
    -- A provider may deliver the same message with another request key. Bind
    -- the accepted key now so a later retry cannot retarget it to new input.
    insert into internal.session_conversation_message_receipts(session_id, receipt_key, sequence)
    values (p_session.id, p_receipt_key, appended_sequence) on conflict (session_id, receipt_key) do nothing;
    return query select appended_sequence, true;
    return;
  end if;
  if p_session.archived_at is not null then
    raise exception 'Session is archived.' using errcode = 'P0003';
  end if;

  perform internal.ensure_session_conversation(p_session);
  update public.session_conversations conversation set last_sequence = last_sequence + 1
  where conversation.session_id = p_session.id returning last_sequence into strict appended_sequence;
  insert into public.session_conversation_messages (
    session_id, workspace_id, factory_id, sequence, kind, author_kind, author_label, originating_member_id,
    originating_service_principal_id,
    run_id, attempt_count, artifact_id, feedback_batch_id, source_id, external_message_id, external_actor_id,
    body_md, body_truncated
  ) values (
    p_session.id, p_session.workspace_id, p_session.factory_id, appended_sequence, p_message.kind, p_message.author_kind,
    left(p_message.author_label, 120), p_message.originating_member_id, p_message.originating_service_principal_id,
    p_message.run_id, p_message.attempt_count,
    p_message.artifact_id, p_message.feedback_batch_id, p_message.source_id, p_message.external_message_id,
    p_message.external_actor_id, p_message.body_md, p_message.body_truncated
  );
  insert into internal.session_conversation_message_receipts(session_id, receipt_key, sequence)
  values (p_session.id, p_receipt_key, appended_sequence);
  return query select appended_sequence, false;
end;
$$;

create or replace function internal.capture_session_conversation_prompt()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  message public.session_conversation_messages;
  prompt text := btrim(new.prompt_md, E' \t\r\n');
begin
  if prompt = '' or new.archived_at is not null then return new; end if;
  message.kind := 'initial_prompt';
  select internal.artifact_review_author_label(actor) into message.author_label
  from public.workspace_members actor
  where (actor.id, actor.workspace_id) = (new.creator_member_id, new.workspace_id) and actor.kind = 'human';
  if found then
    message.author_kind := 'user';
    message.originating_member_id := new.creator_member_id;
  elsif new.creator_service_principal_id is not null then
    message.author_kind := 'service';
    message.originating_service_principal_id := new.creator_service_principal_id;
    select principal.name into strict message.author_label from public.service_principals principal
    where (principal.workspace_id, principal.factory_id, principal.id) =
      (new.workspace_id, new.factory_id, new.creator_service_principal_id);
  else
    message.author_kind := 'system';
    message.author_label := 'Wallie';
    message.originating_member_id := new.creator_member_id;
  end if;
  message.body_md := rtrim(left(prompt, 4000), E' \t\r\n');
  message.body_truncated := length(prompt) > 4000;
  perform internal.append_session_conversation_message(new, message, 'initial_prompt');
  return new;
end;
$$;

-- Preserve the existing queue/pin logic for browser and machine admission.
create function internal.create_attributed_session(
  target_workspace_id uuid,
  creator_member_id uuid,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_linear_issue_id text default null,
  session_linear_issue_url text default null,
  session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null,
  p_actor internal.session_mutation_actor default null,
  p_expected_agent_id uuid default null,
  p_expected_definition_digest text default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
set search_path = ''
as $$
declare
  allocated_number integer;
  created_job_id uuid;
  created_run_id uuid;
  created_session_id uuid;
  first_stage_slug text;
  first_stage_name text;
  pinned_pipeline_id uuid;
  resolved_stage_ids uuid[];
  admitted_factory_id uuid;
  admitted_activation_number bigint;
  admitted_revision_id uuid;
  admitted_definition_digest text;
  admitted_definition jsonb;
  repository_id uuid;
  model_provider text;
  model_name text;
  creator_user_id uuid;
  admitted_execution_policy_revision_id uuid;
  admitted_delivery_policy_revision_id uuid;
  effective_execution_policy_revision_id uuid;
  approved public.factory_execution_grants;
  machine boolean := p_actor.service_principal_id is not null;
begin
  if nullif(btrim(session_title), '') is null then
    raise exception 'Session title must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(session_prompt_md), '') is null then
    raise exception 'Session prompt must not be blank' using errcode = '23514';
  end if;

  -- Take the workspace admission fence before the pipeline lock. Publication
  -- takes the same workspace row for no-key-update, so a racing create uses
  -- exactly one complete activation and never waits in pipeline/workspace order.
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  if p_actor.factory_id is not null then
    if p_actor.workspace_id is distinct from target_workspace_id then
      raise exception 'Session creation authority is unavailable.' using errcode = '42501';
    end if;
    perform internal.assert_factory_accepts_work(target_workspace_id, p_actor.factory_id);
  end if;
  if machine then
    if creator_member_id is not null then
      raise exception 'Session creation authority is unavailable.' using errcode = '42501';
    end if;
    -- The temporary permit belongs to this command transaction only.
    perform internal.assert_session_mutation_actor(p_actor, 'create');
  end if;
  select a.factory_id, a.activation_number, a.revision_id, r.canonical_digest, r.definition_json::jsonb
  into admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest, admitted_definition
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id, a.factory_id) = (f.workspace_id, f.id)
  join public.factory_definition_revisions r on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where f.workspace_id = target_workspace_id
    and case when p_actor.factory_id is null then f.is_default else f.id = p_actor.factory_id end
  order by a.activation_number desc
  limit 1;

  if p_expected_definition_digest is not null and admitted_definition_digest is distinct from p_expected_definition_digest then
    raise exception 'The active factory definition changed.' using errcode = 'P0003';
  end if;
  if machine or p_expected_agent_id is not null then
    if admitted_revision_id is null or p_expected_agent_id is null
      or admitted_definition#>>'{implementationAgent,agentId}' is distinct from p_expected_agent_id::text
      or not (admitted_definition ? 'executionGrant' and admitted_definition ? 'credentialBindingId')
      or (admitted_definition->>'repositoryId')::uuid is distinct from session_github_repository_id
      or p_actor.writer_repository_id is distinct from session_github_repository_id then
      raise exception 'The requested writer and named agent must match an active service-backed factory definition.' using errcode = 'PT422';
    end if;
    approved := internal.resolve_definition_execution_grant(target_workspace_id, admitted_factory_id,
      admitted_definition, session_github_repository_id, (admitted_definition->>'executionPolicyRevisionId')::uuid);
    if (approved.id, approved.version) is distinct from (p_actor.grant_id, p_actor.grant_version)
      or (machine and approved.service_principal_id is distinct from p_actor.service_principal_id) then
      raise exception 'The requested factory execution grant is unavailable.' using errcode = '42501';
    end if;
    perform internal.lock_definition_credential_binding(target_workspace_id, admitted_factory_id, admitted_definition,
      approved.id, approved.service_principal_id);
  end if;

  if admitted_revision_id is null then
    if nullif(btrim(agent_model_provider), '') is null
       or nullif(btrim(agent_model_name), '') is null then
      raise exception 'Agent provider and model must not be blank' using errcode = '23514';
    end if;

    if session_github_repository_id is not null
       and not exists (
         select 1
         from public.github_repositories repository
         where repository.id = session_github_repository_id
           and repository.workspace_id = target_workspace_id
           and repository.is_archived = false
       ) then
      raise exception 'Repository is not available for workspace %', target_workspace_id
        using errcode = '42501';
    end if;

    -- Legacy admission still selects from the live Settings pipeline.
    if selected_pipeline_id is null then
      select pipeline.id
      into pinned_pipeline_id
      from public.pipelines pipeline
      where pipeline.workspace_id = target_workspace_id
        and pipeline.is_default = true
      for update;
    else
      select pipeline.id
      into pinned_pipeline_id
      from public.pipelines pipeline
      where pipeline.id = selected_pipeline_id
        and pipeline.workspace_id = target_workspace_id
      for update;
    end if;

    if pinned_pipeline_id is null then
      raise exception 'Workspace has no selected or default pipeline configured'
        using errcode = 'P0002';
    end if;

    if selected_stage_ids is null then
      select array_agg(stage.id order by stage.position)
      into resolved_stage_ids
      from public.pipeline_stages stage
      where stage.pipeline_id = pinned_pipeline_id
        and stage.workspace_id = target_workspace_id
        and stage.archived_at is null;
    else
      if cardinality(selected_stage_ids) = 0 then
        raise exception 'Select at least one pipeline stage'
          using errcode = '22023';
      end if;

      if array_position(selected_stage_ids, null) is not null
         or cardinality(selected_stage_ids) <> (
           select count(distinct stage_id)
           from unnest(selected_stage_ids) as selected(stage_id)
         ) then
        raise exception 'Selected pipeline stages must be unique and non-null'
          using errcode = '22023';
      end if;

      select array_agg(stage.id order by stage.position)
      into resolved_stage_ids
      from public.pipeline_stages stage
      where stage.pipeline_id = pinned_pipeline_id
        and stage.workspace_id = target_workspace_id
        and stage.archived_at is null
        and stage.id = any(selected_stage_ids);

      if coalesce(cardinality(resolved_stage_ids), 0) <> cardinality(selected_stage_ids) then
        raise exception 'Selected pipeline stages changed or do not belong to this pipeline'
          using errcode = 'P0003';
      end if;
    end if;

    if coalesce(cardinality(resolved_stage_ids), 0) = 0 then
      raise exception 'Selected pipeline has no stages configured'
        using errcode = 'P0002';
    end if;
    select stage.slug, stage.name into first_stage_slug, first_stage_name
    from public.pipeline_stages stage where stage.id = resolved_stage_ids[1];
    repository_id := session_github_repository_id;
    model_provider := btrim(agent_model_provider);
    model_name := btrim(agent_model_name);
  else
    select pipeline.id into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.id = (admitted_definition ->> 'pipelineId')::uuid
      and pipeline.workspace_id = target_workspace_id for share;
    if not found then
      raise exception 'The factory definition pipeline is unavailable.' using errcode = 'P0002';
    end if;
    resolved_stage_ids := internal.read_factory_definition_stage_ids(
      target_workspace_id, pinned_pipeline_id, admitted_definition
    );
    first_stage_slug := admitted_definition #>> '{stages,0,slug}';
    first_stage_name := admitted_definition #>> '{stages,0,name}';
    repository_id := coalesce(session_github_repository_id, (admitted_definition ->> 'repositoryId')::uuid);
    model_provider := admitted_definition #>> '{agent,provider}';
    model_name := admitted_definition #>> '{agent,model}';
    admitted_execution_policy_revision_id := (admitted_definition ->> 'executionPolicyRevisionId')::uuid;
    admitted_delivery_policy_revision_id := (admitted_definition ->> 'deliveryPolicyRevisionId')::uuid;

    -- A create request can confirm the options it displayed. Validate that
    -- ordered selection against the revision that won the admission fence.
    if not internal.factory_allows_writable_repository(admitted_definition, repository_id)
      or (selected_pipeline_id is not null and selected_pipeline_id is distinct from pinned_pipeline_id)
      or (selected_stage_ids is not null and selected_stage_ids is distinct from resolved_stage_ids) then
      raise exception 'The active factory no longer matches the requested session options.' using errcode = 'P0003';
    end if;

    -- GitHub disconnect can hold these rows while waiting on session locks.
    -- Admission retries the request rather than reversing that lock order.
    begin
      perform installation.id from public.github_installations installation
      where installation.workspace_id = target_workspace_id and not installation.suspended
      for share nowait;
      perform 1 from public.github_repositories repository
      join public.github_installations installation
        on (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
      where repository.id = repository_id and repository.workspace_id = target_workspace_id
        and repository.factory_id = admitted_factory_id and not repository.is_archived and not installation.suspended
      for share of repository nowait;
      if not found then
        raise exception 'The factory definition repository is unavailable.' using errcode = 'P0002';
      end if;
    exception when lock_not_available then
      raise exception 'Repository access is changing. Retry session creation.' using errcode = 'P0002';
    end;
  end if;

  -- Membership removal takes the pipeline lock before changing the member.
  if not machine then
    select member.user_id into creator_user_id from public.workspace_members member
    where member.id = creator_member_id and member.workspace_id = target_workspace_id
      and member.kind = 'human' and member.is_active for share;
    if not found or (p_actor.member_id is not null and p_actor.member_id is distinct from creator_member_id) then
      raise exception 'Creator is not an active human member of workspace %', target_workspace_id
        using errcode = '42501';
    end if;

    if admitted_revision_id is not null and not (admitted_definition ? 'executionGrant') then
      perform internal.assert_current_factory_agent_credential(creator_user_id, model_provider, model_name);
    end if;
  end if;

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  insert into public.sessions (
    workspace_id,
    factory_id,
    number,
    title,
    prompt_md,
    creator_member_id,
    creator_service_principal_id,
    linear_issue_id,
    linear_issue_url,
    pipeline_id,
    current_stage_id,
    phase_status,
    github_repository_id,
    factory_definition_provenance,
    factory_definition_revision_id,
    execute_pinned_definition,
    pinned_delivery_policy_revision_id,
    execution_policy_revision_id
  )
  values (
    target_workspace_id,
    admitted_factory_id,
    allocated_number,
    btrim(session_title),
    btrim(session_prompt_md),
    creator_member_id,
    p_actor.service_principal_id,
    session_linear_issue_id,
    session_linear_issue_url,
    pinned_pipeline_id,
    resolved_stage_ids[1],
    'in_progress',
    repository_id,
    case when admitted_revision_id is null then 'legacy' else 'pinned' end,
    admitted_revision_id,
    admitted_revision_id is not null,
    admitted_delivery_policy_revision_id,
    admitted_execution_policy_revision_id
  )
  returning id, sessions.execution_policy_revision_id into created_session_id, effective_execution_policy_revision_id;

  if admitted_revision_id is not null then
    insert into public.session_factory_admission_inputs (
      session_id, workspace_id, factory_id, activation_number, definition_revision_id,
      definition_digest, pipeline_id, github_repository_id, selected_stage_ids,
      execution_policy_revision_id, model_provider, model_name, title_sha256, prompt_sha256, original_title, original_prompt_md
    ) values (
      created_session_id, target_workspace_id, admitted_factory_id, admitted_activation_number,
      admitted_revision_id, admitted_definition_digest, pinned_pipeline_id, repository_id,
      resolved_stage_ids, effective_execution_policy_revision_id, model_provider, model_name,
      encode(sha256(convert_to(btrim(session_title), 'UTF8')), 'hex'),
      encode(sha256(convert_to(btrim(session_prompt_md), 'UTF8')), 'hex'),
      btrim(session_title), btrim(session_prompt_md)
    );
  end if;

  insert into public.session_selected_stages (session_id, workspace_id, stage_id)
  select created_session_id, target_workspace_id, stage.id
  from public.pipeline_stages stage
  where stage.id = any(resolved_stage_ids);

  insert into public.agent_jobs (
    workspace_id,
    session_id,
    requested_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    trigger_type,
    status,
    dedupe_key
  )
  values (
    target_workspace_id,
    created_session_id,
    creator_member_id,
    resolved_stage_ids[1],
    first_stage_slug,
    first_stage_name,
    'assignment',
    'queued',
    'session:' || created_session_id::text || ':active'
  )
  returning id into created_job_id;

  insert into public.agent_runs (
    workspace_id,
    session_id,
    agent_job_id,
    triggered_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    run_type,
    model_provider,
    model_name,
    status
  )
  values (
    target_workspace_id,
    created_session_id,
    created_job_id,
    creator_member_id,
    resolved_stage_ids[1],
    first_stage_slug,
    first_stage_name,
    case when repository_id is null then 'project' else 'code' end,
    model_provider,
    model_name,
    'queued'
  )
  returning id into created_run_id;

  return query
  select
    created_session_id,
    allocated_number,
    workspace.slug,
    created_job_id,
    created_run_id
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
end;
$$;

create or replace function public.create_session_with_first_job(
  target_workspace_id uuid,
  creator_member_id uuid,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_linear_issue_id text default null,
  session_linear_issue_url text default null,
  session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language sql security definer set search_path = '' as $$
  select * from internal.create_attributed_session(
    target_workspace_id, creator_member_id, session_title, session_prompt_md, agent_model_provider, agent_model_name,
    session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id, selected_stage_ids);
$$;
revoke all on function internal.create_attributed_session(
  uuid, uuid, text, text, text, text, text, text, uuid, uuid, uuid[], internal.session_mutation_actor, uuid, text)
  from public, anon, authenticated, service_role;

-- Support a historic pre-shared browser key without trying to reinterpret a
-- different creation path's inputs as equivalent machine intent.
create function internal.assert_no_legacy_machine_creation_key(p_actor internal.session_mutation_actor, p_request_id uuid)
returns void language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from internal.session_creation_requests request
    join public.sessions session on (session.id, session.workspace_id) = (request.session_id, request.workspace_id)
    where (request.workspace_id, session.factory_id, request.request_id) =
      (p_actor.workspace_id, p_actor.factory_id, p_request_id)
  ) then
    raise exception 'The session request identity was already used for different input.' using errcode = 'P0005';
  end if;
end;
$$;
revoke all on function internal.assert_no_legacy_machine_creation_key(internal.session_mutation_actor, uuid)
  from public, anon, authenticated, service_role;

create function internal.create_machine_session(p_actor internal.session_mutation_actor, p_intent jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  accepted record;
  admitted public.sessions;
  agent_id uuid;
  repository_id uuid;
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
    or p_intent - 'title' - 'prompt' - 'agentId' - 'repositoryId' - 'draftSpecification' <> '{}'::jsonb
    or jsonb_typeof(p_intent->'title') is distinct from 'string'
    or jsonb_typeof(p_intent->'prompt') is distinct from 'string'
    or jsonb_typeof(p_intent->'agentId') is distinct from 'string'
    or jsonb_typeof(p_intent->'repositoryId') is distinct from 'string'
    or jsonb_typeof(p_intent->'draftSpecification') is distinct from 'boolean'
    or length(btrim(p_intent->>'title', E' \t\r\n')) not between 1 and 200
    or length(btrim(p_intent->>'prompt', E' \t\r\n')) not between 1 and 20000 then
    raise exception 'A title, prompt, named agent and writable repository are required.' using errcode = '22023';
  end if;
  agent_id := (p_intent->>'agentId')::uuid;
  repository_id := (p_intent->>'repositoryId')::uuid;
  if p_actor.service_principal_id is null or repository_id is distinct from p_actor.writer_repository_id then
    raise exception 'The requested factory execution grant is unavailable.' using errcode = '42501';
  end if;
  select * into strict accepted from internal.create_attributed_session(
    p_actor.workspace_id, null, p_intent->>'title', p_intent->>'prompt', null, null,
    session_github_repository_id=>repository_id, p_actor=>p_actor, p_expected_agent_id=>agent_id);
  if (p_intent->>'draftSpecification')::boolean then
    select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
    perform internal.pin_session_specification_stage(admitted);
  end if;
  return jsonb_build_object('sessionId', accepted.session_id, 'jobId', accepted.job_id, 'runId', accepted.run_id);
end;
$$;
revoke all on function internal.create_machine_session(internal.session_mutation_actor, jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.find_session_creation_command(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  target_factory_id uuid default null, source_session_id uuid default null, draft_specification boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare accepted record; admitted public.sessions;
begin
  if draft_specification is null then raise exception 'Invalid specification drafting option.' using errcode = '22023'; end if;
  select * into accepted from internal.find_session_creation_command(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash, target_factory_id, source_session_id);
  if not found then return; end if;
  select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
  if draft_specification is distinct from (admitted.specification_stage_id is not null) then
    raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
  end if;
  -- A proven original browser receipt works after activation changes. Its
  -- immutable service grant must still be current when a shared receipt exists.
  if exists (
    select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id, receipt.session_id) =
      (target_workspace_id, admitted.factory_id, 'create', target_request_id, admitted.id)
      and receipt.grant_id is not null
  ) then
    perform internal.recheck_session_execution_grant(admitted);
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;

create or replace function public.create_session_command_once(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null,
  draft_specification boolean default false
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  accepted record;
  admitted public.sessions;
  operation_actor internal.session_mutation_actor;
  definition jsonb;
  approved public.factory_execution_grants;
  actual_factory_id uuid;
  agent_id uuid;
  repository_id uuid;
  pipeline_id uuid;
  intent jsonb;
  prior jsonb;
  receipt_exists boolean;
begin
  if draft_specification is null or target_request_id is null
    or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A request identity, digest and valid specification option are required.' using errcode = '22023';
  end if;
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select factory.id into actual_factory_id from public.factories factory
  where factory.workspace_id = target_workspace_id
    and case when target_factory_id is null then factory.is_default else factory.id = target_factory_id end;
  if not found then raise exception 'The active factory changed.' using errcode = 'P0003'; end if;
  perform internal.assert_session_command_access(target_workspace_id, actual_factory_id, creator_member_id);
  perform internal.lock_session_mutation_key(target_workspace_id, actual_factory_id, 'create', target_request_id);

  -- Retain browser-only attachments, restart and per-member request handles.
  -- Acquire the shared key first for every keyed browser command.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_command(target_workspace_id, creator_member_id,
    target_request_id, target_request_hash, target_factory_id, source_session_id, draft_specification);
  if found then
    return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
    return;
  end if;
  select exists (
    select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id) =
      (target_workspace_id, actual_factory_id, 'create', target_request_id)
  ) into receipt_exists;

  if source_session_id is null and coalesce(cardinality(session_attachment_ids), 0) = 0
    and session_linear_issue_id is null and session_linear_issue_url is null
    and length(btrim(session_title, E' \t\r\n')) between 1 and 200
    and length(btrim(session_prompt_md, E' \t\r\n')) between 1 and 20000 then
    -- Browser creation confirmed an immutable published revision. An exact
    -- replay may use it after a later activation, while fresh admission below
    -- must still match the active revision under the workspace admission lock.
    select revision.definition_json::jsonb into definition from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.canonical_digest) =
      (target_workspace_id, actual_factory_id, expected_factory_definition_digest)
      and exists (
        select 1 from public.factory_definition_activations activation
        where (activation.workspace_id, activation.factory_id, activation.revision_id) =
          (revision.workspace_id, revision.factory_id, revision.id)
      );
    agent_id := (definition#>>'{implementationAgent,agentId}')::uuid;
    repository_id := (definition->>'repositoryId')::uuid;
    pipeline_id := (definition->>'pipelineId')::uuid;
    if definition ? 'executionGrant' and definition ? 'credentialBindingId' and agent_id is not null
      and (session_github_repository_id is null or session_github_repository_id = repository_id)
      and (selected_pipeline_id is null or selected_pipeline_id = pipeline_id)
      and (selected_stage_ids is null or selected_stage_ids =
        internal.read_factory_definition_stage_ids(target_workspace_id, pipeline_id, definition)) then
      approved := internal.resolve_definition_execution_grant(target_workspace_id, actual_factory_id,
        definition, repository_id, (definition->>'executionPolicyRevisionId')::uuid);
      operation_actor := row(target_workspace_id, actual_factory_id, creator_member_id, null, null,
        approved.id, approved.version, repository_id, null)::internal.session_mutation_actor;
      intent := jsonb_build_object('title', btrim(session_title, E' \t\r\n'), 'prompt', btrim(session_prompt_md, E' \t\r\n'),
        'agentId', agent_id, 'repositoryId', repository_id, 'draftSpecification', draft_specification);
      prior := internal.find_session_mutation_receipt(operation_actor, 'create', target_request_id, intent);
      if prior is not null then
        return query select (prior->>'sessionId')::uuid, (prior->>'sessionNumber')::integer, prior->>'workspaceSlug',
          (prior->>'jobId')::uuid, (prior->>'runId')::uuid;
        return;
      end if;
    end if;
  end if;

  if intent is not null then
    select * into strict accepted from internal.create_attributed_session(
      target_workspace_id, creator_member_id, intent->>'title', intent->>'prompt', agent_model_provider, agent_model_name,
      session_github_repository_id=>repository_id, selected_pipeline_id=>selected_pipeline_id, selected_stage_ids=>selected_stage_ids,
      p_actor=>operation_actor, p_expected_agent_id=>agent_id, p_expected_definition_digest=>expected_factory_definition_digest);
    insert into internal.session_creation_requests(workspace_id, creator_member_id, request_id, request_hash, session_id, job_id, run_id)
    values (target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      accepted.session_id, accepted.job_id, accepted.run_id);
  else
    if receipt_exists then
      raise exception 'The session request identity was already used for different input.' using errcode = 'P0005';
    end if;
    select * into strict accepted from internal.create_session_command_once(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash, expected_factory_definition_digest,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
      selected_stage_ids, source_session_id, target_factory_id);
    operation_actor := internal.session_mutation_human_actor(target_workspace_id, actual_factory_id, creator_member_id, accepted.session_id);
    intent := jsonb_build_object('browserRequestHash', target_request_hash);
  end if;
  if draft_specification then
    select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
    perform internal.pin_session_specification_stage(admitted);
  end if;
  perform internal.record_session_mutation_receipt(operation_actor, 'create', target_request_id, intent, accepted.session_id,
    jsonb_build_object('jobId', accepted.job_id, 'runId', accepted.run_id));
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;
