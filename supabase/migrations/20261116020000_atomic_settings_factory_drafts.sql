-- Settings factory drafts must check expectedDraftId atomically under the
-- factory head lock and persist candidate execution/delivery policy revisions
-- without advancing the live policy pointers used by legacy sessions.

create or replace function internal.guard_execution_policy()
returns trigger language plpgsql security invoker set search_path='' as $$
declare revision public.execution_policy_revisions;
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id) then return old; end if;
    raise exception 'Execution policy history is immutable.' using errcode='23514';
  end if;
  if tg_table_name='execution_policy_revisions' then
    if tg_op='UPDATE' then raise exception 'Execution policy history is immutable.' using errcode='23514'; end if;
    return new;
  end if;
  select * into revision from public.execution_policy_revisions where id=new.current_revision_id;
  if revision.workspace_id is distinct from new.workspace_id or revision.revision is distinct from new.revision
    or (tg_op='UPDATE' and (new.workspace_id is distinct from old.workspace_id or new.revision<=old.revision)) then
    raise exception 'Execution policy revision does not match the current policy.' using errcode='23514';
  end if;
  return new;
end;
$$;

create or replace function internal.guard_delivery_verification()
returns trigger language plpgsql security invoker set search_path='' as $$
declare policy public.delivery_policy_revisions; observation public.session_pr_verification_observations;
  session public.sessions; epoch public.session_pr_epochs;
begin
  if tg_op='DELETE' then
    if not exists(select 1 from public.workspaces where id=old.workspace_id)
      or not exists(select 1 from public.pipelines where id=(to_jsonb(old)->>'pipeline_id')::uuid)
        and tg_table_name in ('delivery_policy_revisions','delivery_policies')
      or tg_table_name in ('session_pr_verification_observations','session_pr_verification_results')
        and not exists(select 1 from public.sessions where id=(to_jsonb(old)->>'session_id')::uuid) then return old; end if;
    raise exception 'Delivery verification history is immutable.' using errcode='23514';
  end if;
  if tg_op='UPDATE' and tg_table_name<>'delivery_policies' then
    raise exception 'Delivery verification history is immutable.' using errcode='23514';
  end if;
  if tg_table_name='delivery_policy_revisions' then
    if not exists(select 1 from public.pipelines p where p.id=new.pipeline_id and p.workspace_id=new.workspace_id) then
      raise exception 'Delivery policy pipeline is outside the workspace.' using errcode='23514'; end if;
  elsif tg_table_name='delivery_policies' then
    select * into policy from public.delivery_policy_revisions where id=new.current_revision_id;
    if policy.pipeline_id is distinct from new.pipeline_id or policy.workspace_id is distinct from new.workspace_id
      or policy.revision is distinct from new.revision
      or (tg_op='UPDATE' and (new.pipeline_id is distinct from old.pipeline_id or new.workspace_id is distinct from old.workspace_id
        or new.revision<=old.revision)) then
      raise exception 'Delivery policy revision does not match the current policy.' using errcode='23514'; end if;
  elsif tg_table_name='session_pr_verification_observations' then
    select * into session from public.sessions s where s.id=new.session_id and s.workspace_id=new.workspace_id;
    select * into policy from public.delivery_policy_revisions p where p.id=new.policy_revision_id;
    if session.id is null or policy.workspace_id is distinct from new.workspace_id or policy.pipeline_id is distinct from session.pipeline_id then
      raise exception 'Verification policy does not match the session.' using errcode='23514'; end if;
    if new.observed_at>clock_timestamp()+interval '5 seconds' then
      raise exception 'Verification observation time is in the future.' using errcode='23514'; end if;
    if policy.requirements->>'deliveryMode'='code' then
      if new.repository_id is null or new.repository_full_name is null or new.pr_epoch_id is null or new.pr_number is null
        or new.head_sha is null or new.base_sha is null or new.checkpoint_run_id is null then
        raise exception 'Code verification requires a complete canonical PR identity.' using errcode='23514'; end if;
    end if;
    if new.pr_epoch_id is not null then
      select * into epoch from public.session_pr_epochs e where e.id=new.pr_epoch_id;
      if epoch.workspace_id is distinct from new.workspace_id or epoch.session_id is distinct from new.session_id
        or epoch.repository_id is distinct from new.repository_id or epoch.repository_full_name is distinct from new.repository_full_name
        or epoch.pr_number is distinct from new.pr_number then
        raise exception 'Verification canonical PR identity does not match the session.' using errcode='23514'; end if;
    elsif new.pr_number is not null or new.repository_id is not null or new.repository_full_name is not null
      or new.head_sha is not null or new.base_sha is not null or new.checkpoint_run_id is not null then
      raise exception 'Verification identity must be complete or absent for analysis.' using errcode='23514'; end if;
    if new.checkpoint_run_id is not null and not exists(select 1 from public.session_git_checkpoints c
      where c.run_id=new.checkpoint_run_id and c.session_id=new.session_id and c.workspace_id=new.workspace_id
        and c.repository_id=new.repository_id and c.repository_full_name=new.repository_full_name) then
      raise exception 'Verification checkpoint does not match the session repository.' using errcode='23514'; end if;
  else
    select * into observation from public.session_pr_verification_observations o where o.id=new.observation_id;
    select * into policy from public.delivery_policy_revisions p where p.id=observation.policy_revision_id;
    if observation.workspace_id is distinct from new.workspace_id or observation.session_id is distinct from new.session_id then
      raise exception 'Verification result does not match its observation.' using errcode='23514'; end if;
    if (policy.requirements->>'deliveryMode'='analysis' and new.state not in ('unknown','not_applicable'))
      or (policy.requirements->>'deliveryMode'='code' and new.state='not_applicable') then
      raise exception 'Verification state does not match the delivery mode.' using errcode='23514'; end if;
    if new.state='ready' and (observation.source is distinct from 'readiness'
      or observation.payload->>'githubAccess' is distinct from 'available'
      or observation.payload->>'checks' is distinct from 'passed'
      or observation.payload->>'reviews' is distinct from 'passed'
      or observation.payload->>'evidence' is distinct from 'passed'
      or observation.payload->>'threads' is distinct from 'passed') then
      raise exception 'Ready requires explicit successful verification dimensions.' using errcode='23514'; end if;
    if new.state in ('ready','not_applicable') and jsonb_array_length(new.blockers)>0 then
      raise exception 'Successful verification cannot contain blockers.' using errcode='23514'; end if;
  end if;
  return new;
end;
$$;

create or replace function public.save_execution_policy(p_workspace_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.execution_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.execution_policies; next_revision bigint; result public.execution_policy_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.workspaces where id=p_workspace_id for update;
  if not found then raise exception 'Execution policy workspace is unavailable.' using errcode='42501'; end if;
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.execution_policies where workspace_id=p_workspace_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    raise exception 'Execution policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_execution_requirements(p_requirements) then
    raise exception 'Invalid execution requirements.' using errcode='23514'; end if;
  select greatest(
    coalesce(current_policy.revision,0),
    coalesce((select max(r.revision) from public.execution_policy_revisions r where r.workspace_id=p_workspace_id),0)
  )+1 into next_revision;
  insert into public.execution_policy_revisions(workspace_id,revision,requirements,created_by)
    values(p_workspace_id,next_revision,p_requirements,p_actor_user_id) returning * into result;
  insert into public.execution_policies(workspace_id,current_revision_id,revision)
    values(p_workspace_id,result.id,result.revision)
    on conflict(workspace_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;

create or replace function public.save_delivery_policy(p_workspace_id uuid,p_pipeline_id uuid,p_actor_user_id uuid,
  p_expected_revision bigint,p_requirements jsonb)
returns public.delivery_policy_revisions language plpgsql security definer set search_path='' as $$
declare current_policy public.delivery_policies; next_revision bigint; result public.delivery_policy_revisions;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.pipelines p where p.id=p_pipeline_id and p.workspace_id=p_workspace_id for update;
  if not found then raise exception 'Delivery policy pipeline is unavailable.' using errcode='42501'; end if;
  perform 1 from public.workspace_members m where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then raise exception 'Active workspace manager required.' using errcode='42501'; end if;
  select * into current_policy from public.delivery_policies where pipeline_id=p_pipeline_id;
  if p_expected_revision is null or p_expected_revision<>coalesce(current_policy.revision,0) then
    raise exception 'Delivery policy changed. Reload before saving.' using errcode='PT409'; end if;
  if not internal.valid_delivery_requirements(p_requirements) then
    raise exception 'Invalid delivery requirements.' using errcode='23514'; end if;
  select greatest(
    coalesce(current_policy.revision,0),
    coalesce((select max(r.revision) from public.delivery_policy_revisions r where r.pipeline_id=p_pipeline_id),0)
  )+1 into next_revision;
  insert into public.delivery_policy_revisions(workspace_id,pipeline_id,revision,requirements,created_by)
    values(p_workspace_id,p_pipeline_id,next_revision,p_requirements,p_actor_user_id) returning * into result;
  insert into public.delivery_policies(pipeline_id,workspace_id,current_revision_id,revision)
    values(p_pipeline_id,p_workspace_id,result.id,result.revision)
    on conflict(pipeline_id) do update set current_revision_id=excluded.current_revision_id,revision=excluded.revision;
  return result;
end;
$$;

create function public.save_settings_factory_definition_draft(
  p_workspace_id uuid,
  p_factory_id uuid,
  p_actor_user_id uuid,
  p_expected_activation_number bigint,
  p_definition_json text,
  p_canonical_digest text,
  p_expected_draft_id uuid default null,
  p_execution_policy_revision_id uuid default null,
  p_execution_policy_requirements jsonb default null,
  p_expected_live_execution_policy_revision bigint default null,
  p_delivery_policy_revision_id uuid default null,
  p_delivery_policy_pipeline_id uuid default null,
  p_delivery_policy_requirements jsonb default null,
  p_expected_live_delivery_policy_revision bigint default null,
  p_pipeline_rename_id uuid default null,
  p_pipeline_rename_name text default null,
  p_new_pipeline_stages jsonb default null
) returns public.factory_definition_drafts
language plpgsql security definer set search_path = '' as $$
declare
  result public.factory_definition_drafts;
  definition jsonb;
  latest_draft_id uuid;
  live_execution_revision bigint;
  live_delivery_revision bigint;
  next_policy_revision bigint;
  next_stage_position integer;
  stage_item jsonb;
begin
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number
  );
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id
      and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin')
    for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;

  if p_definition_json is null or not (p_definition_json is json object with unique keys) or p_canonical_digest is null then
    raise exception 'A compiled definition and digest are required.' using errcode = '22023';
  end if;
  definition := p_definition_json::jsonb;
  if definition->'schemaVersion' is distinct from '1'::jsonb
    or definition->>'kind' is distinct from 'serial' then
    raise exception 'A version 1 serial definition is required.' using errcode = '22023';
  end if;

  select d.id into latest_draft_id
  from public.factory_definition_drafts d
  where d.workspace_id = p_workspace_id
    and d.factory_id = p_factory_id
    and d.base_activation_number is not distinct from nullif(p_expected_activation_number, 0)
  order by d.created_at desc, d.id desc
  limit 1;

  if latest_draft_id is distinct from p_expected_draft_id then
    raise exception 'Another configuration draft was saved. Reload before retrying.' using errcode = 'PT409';
  end if;

  if p_execution_policy_revision_id is not null or p_execution_policy_requirements is not null then
    if p_execution_policy_revision_id is null or p_execution_policy_requirements is null then
      raise exception 'Execution policy draft requires both revision id and requirements.' using errcode = '22023';
    end if;
    if (definition ->> 'executionPolicyRevisionId')::uuid is distinct from p_execution_policy_revision_id then
      raise exception 'Execution policy revision does not match compiled definition.' using errcode = '22023';
    end if;
    select ep.revision into live_execution_revision
    from public.execution_policies ep
    where ep.workspace_id = p_workspace_id;
    if p_expected_live_execution_policy_revision is not null
      and p_expected_live_execution_policy_revision <> coalesce(live_execution_revision, 0) then
      raise exception 'The execution policy changed. Reload before retrying.' using errcode = 'PT409';
    end if;
    if not internal.valid_execution_requirements(p_execution_policy_requirements) then
      raise exception 'Invalid execution requirements.' using errcode = '23514';
    end if;
    select coalesce(max(r.revision), 0) + 1 into next_policy_revision
    from public.execution_policy_revisions r
    where r.workspace_id = p_workspace_id;
    insert into public.execution_policy_revisions(id, workspace_id, revision, requirements, created_by)
    values (
      p_execution_policy_revision_id, p_workspace_id, next_policy_revision,
      p_execution_policy_requirements, p_actor_user_id
    );
  end if;

  if p_delivery_policy_revision_id is not null
    or p_delivery_policy_pipeline_id is not null
    or p_delivery_policy_requirements is not null then
    if p_delivery_policy_revision_id is null
      or p_delivery_policy_pipeline_id is null
      or p_delivery_policy_requirements is null then
      raise exception 'Delivery policy draft requires revision id, pipeline id, and requirements.' using errcode = '22023';
    end if;
    if (definition ->> 'pipelineId')::uuid is distinct from p_delivery_policy_pipeline_id
      or (definition ->> 'deliveryPolicyRevisionId')::uuid is distinct from p_delivery_policy_revision_id then
      raise exception 'Delivery policy revision does not match compiled definition.' using errcode = '22023';
    end if;
    perform 1 from public.pipelines p
    where p.id = p_delivery_policy_pipeline_id and p.workspace_id = p_workspace_id
    for share;
    if not found then
      raise exception 'Delivery policy pipeline is unavailable.' using errcode = 'PT422';
    end if;
    select dp.revision into live_delivery_revision
    from public.delivery_policies dp
    where dp.pipeline_id = p_delivery_policy_pipeline_id and dp.workspace_id = p_workspace_id;
    if p_expected_live_delivery_policy_revision is not null
      and p_expected_live_delivery_policy_revision <> coalesce(live_delivery_revision, 0) then
      raise exception 'The delivery policy changed. Reload before retrying.' using errcode = 'PT409';
    end if;
    if not internal.valid_delivery_requirements(p_delivery_policy_requirements) then
      raise exception 'Invalid delivery requirements.' using errcode = '23514';
    end if;
    select coalesce(max(r.revision), 0) + 1 into next_policy_revision
    from public.delivery_policy_revisions r
    where r.pipeline_id = p_delivery_policy_pipeline_id;
    insert into public.delivery_policy_revisions(
      id, workspace_id, pipeline_id, revision, requirements, created_by
    ) values (
      p_delivery_policy_revision_id, p_workspace_id, p_delivery_policy_pipeline_id,
      next_policy_revision, p_delivery_policy_requirements, p_actor_user_id
    );
  end if;

  if p_new_pipeline_stages is not null then
    if jsonb_typeof(p_new_pipeline_stages) is distinct from 'array' then
      raise exception 'Invalid pipeline stage anchor payload.' using errcode = '22023';
    end if;
    if jsonb_array_length(p_new_pipeline_stages) > 0 then
      perform 1 from public.pipelines p
      where p.id = (definition ->> 'pipelineId')::uuid and p.workspace_id = p_workspace_id
      for update;
      if not found then
        raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
      end if;
      select coalesce(max(ps.position), 0) into next_stage_position
      from public.pipeline_stages ps
      where ps.pipeline_id = (definition ->> 'pipelineId')::uuid;
      for stage_item in select * from jsonb_array_elements(p_new_pipeline_stages) loop
        if (stage_item ->> 'id')::uuid is null
          or nullif(btrim(stage_item ->> 'slug'), '') is null
          or nullif(btrim(stage_item ->> 'name'), '') is null then
          raise exception 'Pipeline stage anchor requires id, slug, and name.' using errcode = '22023';
        end if;
        next_stage_position := next_stage_position + 1;
        insert into public.pipeline_stages(
          id, workspace_id, pipeline_id, position, slug, name, description,
          prompt_template_md, anyone_can_approve, archived_at
        ) values (
          (stage_item ->> 'id')::uuid,
          p_workspace_id,
          (definition ->> 'pipelineId')::uuid,
          next_stage_position,
          stage_item ->> 'slug',
          stage_item ->> 'name',
          coalesce(stage_item ->> 'description', ''),
          coalesce(stage_item ->> 'promptTemplateMd', ''),
          coalesce((stage_item ->> 'anyoneCanApprove')::boolean, false),
          clock_timestamp()
        );
      end loop;
    end if;
  end if;

  if p_pipeline_rename_id is not null then
    if p_pipeline_rename_id is distinct from (definition ->> 'pipelineId')::uuid
      or p_pipeline_rename_name is null or char_length(btrim(p_pipeline_rename_name)) = 0 then
      raise exception 'Invalid pipeline rename payload.' using errcode = '22023';
    end if;
    update public.pipelines
    set name = p_pipeline_rename_name
    where id = p_pipeline_rename_id and workspace_id = p_workspace_id;
    if not found then
      raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
    end if;
  end if;

  insert into public.factory_definition_drafts(
    workspace_id, factory_id, base_activation_number, schema_version,
    definition_json, canonical_digest, created_by
  ) values (
    p_workspace_id, p_factory_id, nullif(p_expected_activation_number, 0), 1,
    p_definition_json, p_canonical_digest, p_actor_user_id
  ) returning * into result;

  return result;
end;
$$;

revoke all on function public.save_settings_factory_definition_draft(
  uuid, uuid, uuid, bigint, text, text, uuid,
  uuid, jsonb, bigint,
  uuid, uuid, jsonb, bigint,
  uuid, text, jsonb
) from public, anon, authenticated, service_role;

grant execute on function public.save_settings_factory_definition_draft(
  uuid, uuid, uuid, bigint, text, text, uuid,
  uuid, jsonb, bigint,
  uuid, uuid, jsonb, bigint,
  uuid, text, jsonb
) to service_role;
