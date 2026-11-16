-- Candidate smoke tests are private, append-only in identity, and never modify
-- the draft, its backing records, or the active factory configuration.
create table public.factory_definition_smoke_tests (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  target_kind text not null check (target_kind in ('draft', 'revision')),
  target_id uuid not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  base_activation_number bigint not null check (base_activation_number >= 0),
  policy_version integer not null default 1 check (policy_version > 0),
  sandbox_connection_revision uuid,
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  lease_expires_at timestamptz not null,
  finished_at timestamptz,
  status text not null check (status in ('running','passed','blocked','failed','unsupported','canceled')),
  evidence jsonb not null default '{}'::jsonb
    check (jsonb_typeof(evidence) = 'object' and octet_length(evidence::text) <= 65536),
  error_text text check (char_length(error_text) <= 500),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade,
  check (lease_expires_at > created_at),
  check ((status = 'running') = (finished_at is null)),
  check (status = 'blocked' or sandbox_connection_revision is not null)
);

create index factory_definition_smoke_tests_latest_idx on public.factory_definition_smoke_tests
  (workspace_id, factory_id, target_kind, target_id, base_activation_number, policy_version, created_at desc, id desc);
create unique index factory_definition_smoke_tests_running_idx on public.factory_definition_smoke_tests
  (workspace_id, factory_id, target_kind, target_id, base_activation_number, policy_version)
  where status = 'running';

alter table public.factory_definition_smoke_tests enable row level security;
revoke all on public.factory_definition_smoke_tests from public, anon, authenticated, service_role;
grant select on public.factory_definition_smoke_tests to authenticated, service_role;
create policy factory_definition_smoke_tests_select_manager on public.factory_definition_smoke_tests
  for select to authenticated using (
    internal.can_manage_workspace(workspace_id)
    and exists (select 1 from public.workspaces w
      where w.id = factory_definition_smoke_tests.workspace_id and w.deletion_requested_at is null)
  );

-- A Settings draft may own private stage reservations. Validate exact scope
-- and the pending stage set without creating any public backing stages.
create function internal.assert_factory_smoke_stage_reservations(
  p_workspace_id uuid, p_pipeline_id uuid, p_definition jsonb, p_reserved_ids jsonb
) returns void language plpgsql stable security invoker set search_path = '' as $$
declare
  stage_ids uuid[];
  reserved_ids uuid[];
  missing_ids uuid[];
begin
  select array_agg((stage.value->>'id')::uuid) into stage_ids
  from jsonb_array_elements(p_definition->'stages') stage;
  reserved_ids := array(select value::uuid from jsonb_array_elements_text(p_reserved_ids)
    order by value::uuid);
  if coalesce(cardinality(stage_ids), 0) = 0 or array_position(stage_ids, null) is not null
    or cardinality(stage_ids) <> (select count(distinct id) from unnest(stage_ids) as stage(id))
    or exists (select 1 from public.pipeline_stages s where s.id = any(stage_ids)
      and (s.workspace_id, s.pipeline_id) is distinct from (p_workspace_id, p_pipeline_id)) then
    raise exception 'The factory definition has stages unavailable in its pipeline.' using errcode = 'PT422';
  end if;
  missing_ids := array(select stage.id from unnest(stage_ids) as stage(id)
    where not exists (select 1 from public.pipeline_stages s where s.id = stage.id) order by stage.id);
  if reserved_ids is distinct from missing_ids then
    raise exception 'New stage reservations do not match the definition.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_smoke_stage_reservations(uuid,uuid,jsonb,jsonb)
  from public, anon, authenticated, service_role;

create function internal.assert_factory_authority(
  p_workspace_id uuid,
  p_actor_user_id uuid,
  p_definition jsonb,
  p_definition_digest text,
  p_enabled_sandbox_providers text[],
  p_required_probes text[],
  p_settings_metadata jsonb
) returns void
language plpgsql security invoker set search_path = '' as $$
declare
  v_pipeline_id uuid := (p_definition ->> 'pipelineId')::uuid;
  v_repository_id uuid := (p_definition ->> 'repositoryId')::uuid;
  v_execution_revision_id uuid := (p_definition ->> 'executionPolicyRevisionId')::uuid;
  v_delivery_revision_id uuid := (p_definition ->> 'deliveryPolicyRevisionId')::uuid;
  v_agent_provider text := p_definition #>> '{agent,provider}';
  v_agent_model text := p_definition #>> '{agent,model}';
  v_sandbox_provider text := p_definition ->> 'sandboxProvider';
  v_pipeline_available boolean;
  v_named_approvers uuid[];
  v_eligible_approvers integer;
  v_installation_id uuid;
  v_connection_revision uuid;
  v_capability public.sandbox_capability_checks;
begin
  -- Pipeline rewrites and member removal lock pipelines before membership.
  perform 1 from public.pipelines p
    where p.id = v_pipeline_id and p.workspace_id = p_workspace_id for share;
  v_pipeline_available := found;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = p_actor_user_id
      and m.kind = 'human' and m.is_active and m.role in ('owner', 'admin')
    for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  if not v_pipeline_available then
    raise exception 'The definition pipeline is unavailable.' using errcode = 'PT422';
  end if;

  select array_agg(distinct member_id.value::uuid) into v_named_approvers
    from jsonb_array_elements(p_definition -> 'stages') stage
    cross join lateral jsonb_array_elements_text(stage.value -> 'approverMemberIds') member_id;
  perform m.id from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.id = any(v_named_approvers)
      and m.kind = 'human' and m.is_active
    order by m.id for share;
  get diagnostics v_eligible_approvers = row_count;
  if v_eligible_approvers <> coalesce(cardinality(v_named_approvers), 0) then
    raise exception 'A definition approver is no longer eligible.' using errcode = 'PT422';
  end if;

  if v_execution_revision_id is not null and not exists (
    select 1 from public.execution_policy_revisions r
      where r.id = v_execution_revision_id and r.workspace_id = p_workspace_id
  ) and not (
    (p_settings_metadata #>> '{executionPolicy,id}')::uuid is not distinct from v_execution_revision_id
    and internal.valid_execution_requirements(p_settings_metadata #> '{executionPolicy,requirements}') is true
    and not exists (select 1 from public.execution_policy_revisions r where r.id = v_execution_revision_id)
  ) then
    raise exception 'The execution policy revision is unavailable.' using errcode = 'PT422';
  end if;
  if v_delivery_revision_id is not null and not exists (
    select 1 from public.delivery_policy_revisions r
      where r.id = v_delivery_revision_id and r.workspace_id = p_workspace_id
        and r.pipeline_id = v_pipeline_id
  ) and not (
    (p_settings_metadata #>> '{deliveryPolicy,id}')::uuid is not distinct from v_delivery_revision_id
    and internal.valid_delivery_requirements(p_settings_metadata #> '{deliveryPolicy,requirements}') is true
    and not exists (select 1 from public.delivery_policy_revisions r where r.id = v_delivery_revision_id)
  ) then
    raise exception 'The delivery policy revision is unavailable for this pipeline.' using errcode = 'PT422';
  end if;

  -- A GitHub disconnect can cascade to sessions locked by workers waiting for
  -- the workspace fence. Retry if that write already owns either GitHub row.
  begin
    select i.id into v_installation_id from public.github_installations i
      where i.workspace_id = p_workspace_id and not i.suspended for share nowait;
    perform 1 from public.github_repositories r
      where r.id = v_repository_id and r.workspace_id = p_workspace_id
        and r.github_installation_id = v_installation_id and not r.is_archived
      for share nowait;
    if not found then
      raise exception 'The definition repository is unavailable.' using errcode = 'PT422';
    end if;
  exception when lock_not_available then
    raise exception 'Repository access is changing. Reload the factory before retrying.' using errcode = 'PT409';
  end;

  if v_sandbox_provider not in ('vercel', 'e2b', 'daytona')
    or (v_sandbox_provider = any(p_enabled_sandbox_providers)) is distinct from true then
    raise exception 'The sandbox provider is disabled for this deployment.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.workspace_sandbox_connection_mutations m
      where m.workspace_id = p_workspace_id and m.provider = v_sandbox_provider
        and m.expires_at > clock_timestamp()
  ) then
    raise exception 'The sandbox connection is being updated.' using errcode = 'PT422';
  end if;

  -- Connection updates already take the workspace lock. A separate connection
  -- row lock here would reverse their row/workspace lock order.
  v_connection_revision := internal.factory_connected_sandbox_revision(p_workspace_id, v_sandbox_provider);
  if v_connection_revision is null then
    raise exception 'The sandbox credential is unavailable.' using errcode = 'PT422';
  end if;

  -- Prefer this immutable candidate's probe. Live receipts remain useful
  -- when their selected runtime already matches and no candidate was checked.
  select c.* into v_capability from public.sandbox_capability_checks c
    where c.workspace_id = p_workspace_id and c.github_repository_id = v_repository_id
      and c.factory_definition_digest = p_definition_digest
    order by c.checked_at desc, c.id desc limit 1 for share;
  if not found then
    select c.* into v_capability from public.sandbox_capability_checks c
      where c.workspace_id = p_workspace_id and c.github_repository_id = v_repository_id
        and c.factory_definition_digest is null
      order by c.checked_at desc, c.id desc limit 1 for share;
  end if;
  if not found or v_capability.status is distinct from 'success'
    or v_capability.sandbox_provider is distinct from v_sandbox_provider
    or v_capability.sandbox_connection_revision is distinct from v_connection_revision
    or v_capability.agent_provider is distinct from v_agent_provider
    or v_capability.agent_model is distinct from v_agent_model
    or coalesce(cardinality(p_required_probes), 0) = 0
    or exists (
      select 1 from unnest(p_required_probes) required(probe)
        where v_capability.capabilities #> array[required.probe, 'ok'] is distinct from 'true'::jsonb
    ) then
    raise exception 'A current capability check is required for this repository, sandbox, and agent.' using errcode = 'PT422';
  end if;

  perform internal.assert_current_factory_agent_credential(p_actor_user_id, v_agent_provider, v_agent_model);
  if p_settings_metadata ? 'newStageIds' then
    perform internal.assert_factory_smoke_stage_reservations(
      p_workspace_id, v_pipeline_id, p_definition, p_settings_metadata->'newStageIds');
  else
    perform internal.read_factory_definition_stage_ids(p_workspace_id, v_pipeline_id, p_definition);
  end if;
end;
$$;
revoke all on function internal.assert_factory_authority(uuid,uuid,jsonb,text,text[],text[],jsonb)
  from public, anon, authenticated, service_role;

create or replace function internal.assert_factory_activation_authority(
  p_workspace_id uuid, p_actor_user_id uuid, p_definition jsonb, p_definition_digest text,
  p_enabled_sandbox_providers text[], p_required_probes text[]
) returns void language sql security invoker set search_path = '' as $$
  select internal.assert_factory_authority(p_workspace_id, p_actor_user_id, p_definition,
    p_definition_digest, p_enabled_sandbox_providers, p_required_probes, '{}'::jsonb);
$$;

-- Reserve a single short-lived execution after the same authority checks
-- used for activation. A blocked result is still durable test evidence.
create function public.start_factory_definition_smoke_test(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_target_kind text, p_target_id uuid, p_definition_digest text,
  p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_smoke_tests
language plpgsql security definer set search_path = '' as $$
declare
  draft public.factory_definition_drafts;
  revision public.factory_definition_revisions;
  result public.factory_definition_smoke_tests;
  definition jsonb;
  digest text;
  metadata jsonb := '{}'::jsonb;
  connection_revision uuid;
  failure text;
  started_at timestamptz;
begin
  if p_target_kind is null or p_target_kind not in ('draft', 'revision') then
    raise exception 'A draft or revision is required for a smoke test.' using errcode = '22023';
  end if;
  perform internal.lock_factory_definition_head(
    p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  if p_target_kind = 'draft' then
    select * into draft from public.factory_definition_drafts d
    where (d.workspace_id, d.factory_id, d.id) = (p_workspace_id, p_factory_id, p_target_id);
    if not found then
      raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002';
    end if;
    if (coalesce(draft.base_activation_number, 0) <> p_expected_activation_number) then
      raise exception 'The factory draft has a stale activation base.' using errcode = 'PT409';
    end if;
    definition := draft.definition_json::jsonb;
    digest := draft.canonical_digest;
    metadata := draft.settings_metadata;
  else
    select * into revision from public.factory_definition_revisions r
    where (r.workspace_id, r.factory_id, r.id) = (p_workspace_id, p_factory_id, p_target_id)
      and exists (select 1 from public.factory_definition_activations a
        where (a.workspace_id, a.factory_id, a.revision_id) = (r.workspace_id, r.factory_id, r.id));
    if not found then
      raise exception 'A previously active factory revision is required.' using errcode = 'P0002';
    end if;
    definition := revision.definition_json::jsonb;
    digest := revision.canonical_digest;
  end if;
  if digest is distinct from p_definition_digest then
    raise exception 'The factory candidate digest changed. Reload before testing.' using errcode = 'PT409';
  end if;

  started_at := clock_timestamp();
  update public.factory_definition_smoke_tests t set status = 'failed', finished_at = started_at,
    error_text = 'The smoke test expired before reporting a result.'
  where (t.workspace_id, t.factory_id) = (p_workspace_id, p_factory_id)
    and t.status = 'running' and t.lease_expires_at <= started_at;
  if exists (select 1 from public.factory_definition_smoke_tests t
    where (t.workspace_id, t.factory_id, t.target_kind, t.target_id, t.base_activation_number) =
      (p_workspace_id, p_factory_id, p_target_kind, p_target_id, p_expected_activation_number)
    and t.policy_version = 1 and t.status = 'running')
  then
    raise exception 'A smoke test for this candidate is already running.' using errcode = 'PT409';
  end if;

  begin
    perform internal.assert_factory_authority(p_workspace_id, p_actor_user_id, definition, digest,
      p_enabled_sandbox_providers, p_required_probes, metadata);
    connection_revision := internal.factory_connected_sandbox_revision(
      p_workspace_id, definition->>'sandboxProvider');
  exception when sqlstate 'PT422' then
    failure := sqlerrm;
  end;
  insert into public.factory_definition_smoke_tests(
    workspace_id, factory_id, target_kind, target_id, definition_digest, base_activation_number,
    sandbox_connection_revision, created_by, created_at, lease_expires_at, finished_at, status, error_text
  ) values (
    p_workspace_id, p_factory_id, p_target_kind, p_target_id, digest, p_expected_activation_number,
    connection_revision, p_actor_user_id, started_at, started_at + interval '5 minutes',
    case when failure is not null then clock_timestamp() end,
    case when failure is not null then 'blocked' else 'running' end, failure
  ) returning * into result;
  return result;
end;
$$;

-- The owning execution can finish its unique reservation once. Cancellation,
-- expiry or another terminal result cannot be overwritten by a late reply.
create function public.finish_factory_definition_smoke_test(
  p_workspace_id uuid, p_test_id uuid, p_status text, p_evidence jsonb, p_error_text text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  test public.factory_definition_smoke_tests;
  definition jsonb;
  stage_count integer;
  expected_stages text[];
  tested_stages text[];
begin
  if p_status is null or p_status not in ('passed','blocked','failed','unsupported','canceled')
    or jsonb_typeof(p_evidence) is distinct from 'object' then
    raise exception 'A terminal smoke test result is required.' using errcode = '22023';
  end if;
  select * into test from public.factory_definition_smoke_tests t
   where (t.workspace_id, t.id) = (p_workspace_id, p_test_id)
     and t.status = 'running' and t.lease_expires_at > clock_timestamp()
   for update;
  if not found then return false; end if;

  if p_status = 'passed' then
    if test.target_kind = 'draft' then
      select d.definition_json::jsonb into definition from public.factory_definition_drafts d
       where (d.workspace_id, d.factory_id, d.id) = (test.workspace_id, test.factory_id, test.target_id);
    else
      select r.definition_json::jsonb into definition from public.factory_definition_revisions r
       where (r.workspace_id, r.factory_id, r.id) = (test.workspace_id, test.factory_id, test.target_id);
    end if;
    if definition is null or jsonb_typeof(p_evidence->'stages') is distinct from 'array'
      or ((p_evidence->>'runtimeProfile') in ('fake', definition->>'sandboxProvider')) is distinct from true
    then
      raise exception 'Passing evidence must describe the selected runtime and stages.' using errcode = '22023';
    end if;
    stage_count := jsonb_array_length(definition->'stages');
    select array_agg(s.value->>'id' order by s.position) into expected_stages
      from jsonb_array_elements(definition->'stages') with ordinality s(value, position)
      where s.position <= 32;
    select array_agg(s.value->>'stageId' order by s.position) into tested_stages
      from jsonb_array_elements(p_evidence->'stages') with ordinality s(value, position);
    if stage_count is null or stage_count = 0
      or p_evidence->'stageCount' is distinct from to_jsonb(stage_count)
      or p_evidence->'completedStageCount' is distinct from to_jsonb(stage_count)
      or expected_stages is distinct from tested_stages
      or exists (select 1 from jsonb_array_elements(p_evidence->'stages') as s(value)
        where (s.value->>'promptDigest' ~ '^[a-f0-9]{64}$') is distinct from true)
    then
      raise exception 'Passing evidence must confirm all stages and the ordered stage sample.' using errcode = '22023';
    end if;
  end if;

  update public.factory_definition_smoke_tests t set status = p_status, evidence = p_evidence,
    error_text = p_error_text, finished_at = clock_timestamp()
  where t.id = test.id and t.lease_expires_at > clock_timestamp();
  return found;
end;
$$;

create function public.cancel_factory_definition_smoke_test(
  p_workspace_id uuid, p_test_id uuid, p_actor_user_id uuid, p_definition_digest text
) returns public.factory_definition_smoke_tests
language plpgsql security definer set search_path = '' as $$
declare result public.factory_definition_smoke_tests;
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id and w.deletion_requested_at is null
    for no key update;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;
  perform 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  select * into result from public.factory_definition_smoke_tests t
    where (t.workspace_id, t.id) = (p_workspace_id, p_test_id) for update;
  if not found then
    raise exception 'Factory smoke test is unavailable.' using errcode = 'P0002';
  end if;
  if result.definition_digest is distinct from p_definition_digest then
    raise exception 'The factory candidate digest changed.' using errcode = 'PT409';
  end if;
  if result.status = 'canceled' then return result; end if;
  if result.status <> 'running' or result.lease_expires_at <= clock_timestamp() then
    raise exception 'The smoke test is no longer running.' using errcode = 'PT409';
  end if;
  update public.factory_definition_smoke_tests t set status = 'canceled', finished_at = clock_timestamp()
    where t.id = result.id returning * into result;
  return result;
end;
$$;

revoke all on function public.start_factory_definition_smoke_test(uuid,uuid,uuid,bigint,text,uuid,text,text[],text[]),
  public.finish_factory_definition_smoke_test(uuid,uuid,text,jsonb,text),
  public.cancel_factory_definition_smoke_test(uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;
grant execute on function public.start_factory_definition_smoke_test(uuid,uuid,uuid,bigint,text,uuid,text,text[],text[]),
  public.finish_factory_definition_smoke_test(uuid,uuid,text,jsonb,text),
  public.cancel_factory_definition_smoke_test(uuid,uuid,uuid,text) to service_role;

-- Enforce policy inside both activation commands, under their existing
-- workspace/factory fence. The most recent exact test is decisive.
create function internal.assert_factory_activation_smoke_test(
  p_workspace_id uuid, p_factory_id uuid, p_activation_number bigint, p_target_kind text,
  p_target_id uuid, p_definition_digest text, p_sandbox_provider text
) returns void language plpgsql security invoker set search_path = '' as $$
declare test public.factory_definition_smoke_tests;
begin
  select t.* into test from public.factory_definition_smoke_tests t
  where (t.workspace_id, t.factory_id, t.target_kind, t.target_id, t.base_activation_number, t.policy_version) =
    (p_workspace_id, p_factory_id, p_target_kind, p_target_id, p_activation_number, 1)
  order by t.created_at desc, t.id desc limit 1 for share;
  if not found or test.status is distinct from 'passed'
    or test.definition_digest is distinct from p_definition_digest
    or test.evidence->>'runtimeProfile' is distinct from p_sandbox_provider
    or test.finished_at <= clock_timestamp() - interval '24 hours'
    or test.sandbox_connection_revision is distinct from
      internal.factory_connected_sandbox_revision(p_workspace_id, p_sandbox_provider)
  then
    raise exception 'A current passing smoke test is required for the exact factory candidate.' using errcode = 'PT422';
  end if;
  perform 1 from public.workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = test.created_by
      and m.kind = 'human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then
    raise exception 'A current passing smoke test is required for the exact factory candidate.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_activation_smoke_test(uuid,uuid,bigint,text,uuid,text,text)
  from public, anon, authenticated, service_role;

create or replace function public.publish_factory_definition_draft(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_draft_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
declare draft public.factory_definition_drafts; published_id uuid; result public.factory_definition_activations;
begin
  perform internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  select * into draft from public.factory_definition_drafts d
  where (d.workspace_id, d.factory_id, d.id) = (p_workspace_id, p_factory_id, p_draft_id);
  if not found then
    raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002';
  end if;
  if coalesce(draft.base_activation_number, 0) <> p_expected_activation_number then
    raise exception 'The draft was saved against a different activation. Save a new draft before publishing.' using errcode = 'PT409';
  end if;
  perform internal.materialize_factory_settings_draft(draft, p_actor_user_id);
  perform internal.assert_factory_activation_authority(p_workspace_id, p_actor_user_id,
    draft.definition_json::jsonb, draft.canonical_digest, p_enabled_sandbox_providers, p_required_probes);
  perform internal.assert_factory_activation_smoke_test(p_workspace_id, p_factory_id,
    p_expected_activation_number, 'draft', draft.id, draft.canonical_digest,
    draft.definition_json::jsonb->>'sandboxProvider');
  insert into public.factory_definition_revisions(
    workspace_id, factory_id, source_draft_id, schema_version, definition_json, canonical_digest, created_by
  ) values (p_workspace_id, p_factory_id, draft.id, draft.schema_version, draft.definition_json,
    draft.canonical_digest, p_actor_user_id) returning id into published_id;
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  values (p_workspace_id, p_factory_id, published_id, p_expected_activation_number + 1, p_actor_user_id)
  returning * into result;
  return result;
end;
$$;

create or replace function public.rollback_factory_definition(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_expected_activation_number bigint,
  p_revision_id uuid, p_enabled_sandbox_providers text[], p_required_probes text[]
) returns public.factory_definition_activations
language plpgsql security definer set search_path = '' as $$
declare head public.factory_definition_activations; revision public.factory_definition_revisions;
  result public.factory_definition_activations;
begin
  head := internal.lock_factory_definition_head(p_workspace_id, p_factory_id, p_actor_user_id, p_expected_activation_number);
  select r.* into revision from public.factory_definition_revisions r
  where (r.workspace_id, r.factory_id, r.id) = (p_workspace_id, p_factory_id, p_revision_id)
    and exists (select 1 from public.factory_definition_activations a
      where (a.workspace_id, a.factory_id, a.revision_id) = (r.workspace_id, r.factory_id, r.id));
  if not found then
    raise exception 'A previously active factory revision is required.' using errcode = 'P0002';
  end if;
  if revision.id = head.revision_id then
    raise exception 'This factory definition is already active.' using errcode = 'PT409';
  end if;
  perform internal.assert_factory_activation_authority(p_workspace_id, p_actor_user_id,
    revision.definition_json::jsonb, revision.canonical_digest, p_enabled_sandbox_providers, p_required_probes);
  perform internal.assert_factory_activation_smoke_test(p_workspace_id, p_factory_id,
    p_expected_activation_number, 'revision', revision.id, revision.canonical_digest,
    revision.definition_json::jsonb->>'sandboxProvider');
  insert into public.factory_definition_activations(workspace_id, factory_id, revision_id, activation_number, created_by)
  values (p_workspace_id, p_factory_id, revision.id, p_expected_activation_number + 1, p_actor_user_id)
  returning * into result;
  return result;
end;
$$;
