create type public.benchmark_replay_profile as enum ('blocked', 'recorded_fixtures', 'isolated_test');
create type public.benchmark_replay_operation as enum (
  'tool_read', 'tool_write', 'git_write', 'chat_write', 'issue_write', 'deployment_write', 'external_tool'
);

create table public.factory_benchmark_replay_fixture_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  operation public.benchmark_replay_operation not null check (operation <> 'external_tool'),
  fixture_key text not null check (fixture_key ~ '^[a-f0-9]{64}$'),
  revision_number integer not null check (revision_number > 0),
  response_json text not null check (response_json is json with unique keys and octet_length(response_json) <= 65536),
  response_sha256 text not null check (response_sha256 = encode(sha256(convert_to(response_json, 'UTF8')), 'hex')),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, operation, fixture_key, revision_number),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_benchmark_replay_policy_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  profile public.benchmark_replay_profile not null,
  revision_number integer not null check (revision_number > 0),
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, revision_number),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table internal.factory_benchmark_replay_policy_fixtures (
  workspace_id uuid not null,
  factory_id uuid not null,
  policy_revision_id uuid not null,
  fixture_revision_id uuid not null,
  primary key (policy_revision_id, fixture_revision_id),
  foreign key (workspace_id, factory_id, policy_revision_id)
    references public.factory_benchmark_replay_policy_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, fixture_revision_id)
    references public.factory_benchmark_replay_fixture_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_replay_policy_fixture_fk_idx
  on internal.factory_benchmark_replay_policy_fixtures(workspace_id, factory_id, fixture_revision_id);

create table internal.factory_benchmark_replay_revocations (
  workspace_id uuid not null,
  factory_id uuid not null,
  policy_revision_id uuid unique,
  fixture_revision_id uuid unique,
  revoked_by uuid not null,
  revoked_at timestamptz not null default clock_timestamp(),
  check (num_nonnulls(policy_revision_id, fixture_revision_id) = 1),
  foreign key (workspace_id, factory_id, policy_revision_id)
    references public.factory_benchmark_replay_policy_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, fixture_revision_id)
    references public.factory_benchmark_replay_fixture_revisions(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_benchmark_replay_executions (
  id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  task_id uuid not null,
  task_revision_id uuid not null,
  policy_revision_id uuid not null,
  policy_digest text not null check (policy_digest ~ '^[a-f0-9]{64}$'),
  profile public.benchmark_replay_profile not null,
  restoration_receipt_sha256 text not null check (restoration_receipt_sha256 ~ '^[a-f0-9]{64}$'),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  foreign key (workspace_id, factory_id, task_id, task_revision_id)
    references public.factory_benchmark_task_revisions(workspace_id, factory_id, task_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, policy_revision_id)
    references public.factory_benchmark_replay_policy_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_replay_executions_task_idx
  on public.factory_benchmark_replay_executions(workspace_id, factory_id, task_id, task_revision_id);
create index factory_benchmark_replay_executions_policy_idx
  on public.factory_benchmark_replay_executions(workspace_id, factory_id, policy_revision_id);

create table public.factory_benchmark_replay_operations (
  workspace_id uuid not null,
  factory_id uuid not null,
  execution_id uuid not null,
  operation_id uuid not null,
  operation public.benchmark_replay_operation not null,
  fixture_key text check (fixture_key ~ '^[a-f0-9]{64}$'),
  decision text not null check (decision in ('denied', 'stubbed')),
  reason text not null check (reason in (
    'policy_blocked', 'operation_blocked', 'fixture_unavailable', 'fixture_revoked', 'fixture_matched'
  )),
  fixture_revision_id uuid,
  fixture_response_sha256 text check (fixture_response_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  primary key (execution_id, operation_id),
  check (case when decision = 'stubbed' then
    fixture_key is not null and fixture_revision_id is not null and fixture_response_sha256 is not null
      and reason = 'fixture_matched'
    else fixture_revision_id is null and fixture_response_sha256 is null and reason <> 'fixture_matched' end),
  foreign key (workspace_id, factory_id, execution_id)
    references public.factory_benchmark_replay_executions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, fixture_revision_id)
    references public.factory_benchmark_replay_fixture_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_replay_operations_fixture_idx
  on public.factory_benchmark_replay_operations(workspace_id, factory_id, fixture_revision_id)
  where fixture_revision_id is not null;

alter table public.factory_benchmark_replay_fixture_revisions enable row level security;
alter table public.factory_benchmark_replay_policy_revisions enable row level security;
alter table internal.factory_benchmark_replay_policy_fixtures enable row level security;
alter table internal.factory_benchmark_replay_revocations enable row level security;
alter table public.factory_benchmark_replay_executions enable row level security;
alter table public.factory_benchmark_replay_operations enable row level security;
revoke all on public.factory_benchmark_replay_fixture_revisions, public.factory_benchmark_replay_policy_revisions,
  internal.factory_benchmark_replay_policy_fixtures, internal.factory_benchmark_replay_revocations,
  public.factory_benchmark_replay_executions, public.factory_benchmark_replay_operations
  from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_replay_policy_revisions, public.factory_benchmark_replay_executions
  to authenticated, service_role;
grant select on public.factory_benchmark_replay_operations to service_role;
grant select (workspace_id, factory_id, execution_id, operation_id, operation, decision, reason,
  fixture_revision_id, fixture_response_sha256, created_at) on public.factory_benchmark_replay_operations to authenticated;
create policy factory_benchmark_replay_policies_read on public.factory_benchmark_replay_policy_revisions
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_replay_executions_read on public.factory_benchmark_replay_executions
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_benchmark_replay_operations_read on public.factory_benchmark_replay_operations
  for select to authenticated using (internal.can_access_factory(workspace_id, factory_id));

create trigger preserve_benchmark_replay_fixture_revisions before update or delete on public.factory_benchmark_replay_fixture_revisions
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_benchmark_replay_policy_revisions before update or delete on public.factory_benchmark_replay_policy_revisions
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_benchmark_replay_policy_fixtures before update or delete on internal.factory_benchmark_replay_policy_fixtures
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_benchmark_replay_revocations before update or delete on internal.factory_benchmark_replay_revocations
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_benchmark_replay_executions before update or delete on public.factory_benchmark_replay_executions
  for each row execute function internal.preserve_factory_benchmark_history();
create trigger preserve_benchmark_replay_operations before update or delete on public.factory_benchmark_replay_operations
  for each row execute function internal.preserve_factory_benchmark_history();

comment on table public.factory_benchmark_replay_fixture_revisions is
  'Approved local responses. Bytes are released only by the scoped replay operation command.';
comment on table public.factory_benchmark_replay_operations is
  'Redacted denial and fixture evidence. Browser roles never receive request fingerprints or response bytes.';

create function public.publish_factory_benchmark_replay_fixture(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_operation public.benchmark_replay_operation,
  p_fixture_key text, p_response_json text, p_expected_revision_id uuid default null
) returns table (id uuid, revision_number integer, response_sha256 text)
language plpgsql security definer set search_path = '' as $$
declare base public.factory_benchmark_replay_fixture_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_operation is null or p_operation = 'external_tool' or p_fixture_key is null or p_fixture_key !~ '^[a-f0-9]{64}$'
    or p_response_json is null or not (p_response_json is json with unique keys)
    or octet_length(p_response_json) > 65536 then
    raise exception 'Provide an exact local fixture with bounded JSON response bytes.' using errcode = '22023';
  end if;

  select fixture.* into base from public.factory_benchmark_replay_fixture_revisions fixture
  where (fixture.workspace_id, fixture.factory_id, fixture.operation, fixture.fixture_key) =
    (p_workspace_id, p_factory_id, p_operation, p_fixture_key)
  order by fixture.revision_number desc limit 1;
  if p_expected_revision_id is distinct from base.id then
    raise exception 'The replay fixture changed. Reload its latest revision.' using errcode = 'PT409';
  end if;

  return query insert into public.factory_benchmark_replay_fixture_revisions as fixture (
    workspace_id, factory_id, operation, fixture_key, revision_number, response_json, response_sha256, created_by
  ) values (
    p_workspace_id, p_factory_id, p_operation, p_fixture_key, coalesce(base.revision_number, 0) + 1,
    p_response_json, encode(sha256(convert_to(p_response_json, 'UTF8')), 'hex'), p_actor_user_id
  ) returning fixture.id, fixture.revision_number, fixture.response_sha256;
end;
$$;

create function public.publish_factory_benchmark_replay_policy(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_profile public.benchmark_replay_profile,
  p_expected_revision_id uuid default null, p_fixture_revision_ids uuid[] default '{}'
) returns public.factory_benchmark_replay_policy_revisions
language plpgsql security definer set search_path = '' as $$
declare
  base public.factory_benchmark_replay_policy_revisions;
  result public.factory_benchmark_replay_policy_revisions;
  canonical_fixtures jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if p_profile is null or p_fixture_revision_ids is null or array_ndims(p_fixture_revision_ids) > 1
    or (p_profile = 'blocked' and cardinality(p_fixture_revision_ids) > 0) then
    raise exception 'Provide fixtures compatible with the selected replay profile.' using errcode = '22023';
  end if;

  select revision.* into base from public.factory_benchmark_replay_policy_revisions revision
  where (revision.workspace_id, revision.factory_id) = (p_workspace_id, p_factory_id)
  order by revision.revision_number desc limit 1;
  if p_expected_revision_id is distinct from base.id then
    raise exception 'The replay policy changed. Reload its latest revision.' using errcode = 'PT409';
  end if;

  select coalesce(jsonb_agg(jsonb_build_array(fixture.id, fixture.response_sha256) order by fixture.id), '[]'::jsonb)
  into canonical_fixtures from public.factory_benchmark_replay_fixture_revisions fixture
  where (fixture.workspace_id, fixture.factory_id) = (p_workspace_id, p_factory_id)
    and fixture.id = any(p_fixture_revision_ids)
    and (p_profile = 'isolated_test' or fixture.operation = 'tool_read')
    and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
      where revoked.fixture_revision_id = fixture.id);
  if jsonb_array_length(canonical_fixtures) <> cardinality(p_fixture_revision_ids) or exists (
    select 1 from public.factory_benchmark_replay_fixture_revisions fixture
    where (fixture.workspace_id, fixture.factory_id) = (p_workspace_id, p_factory_id)
      and fixture.id = any(p_fixture_revision_ids)
    group by fixture.operation, fixture.fixture_key having count(*) > 1
  ) then
    raise exception 'A fixture is unavailable, repeated, or incompatible with the replay profile.' using errcode = 'PT422';
  end if;

  insert into public.factory_benchmark_replay_policy_revisions (
    workspace_id, factory_id, profile, revision_number, policy_digest, created_by
  ) values (
    p_workspace_id, p_factory_id, p_profile, coalesce(base.revision_number, 0) + 1,
    encode(sha256(convert_to(jsonb_build_array('wallie-benchmark-replay/v1', p_profile, canonical_fixtures)::text, 'UTF8')), 'hex'),
    p_actor_user_id
  ) returning * into result;
  insert into internal.factory_benchmark_replay_policy_fixtures (workspace_id, factory_id, policy_revision_id, fixture_revision_id)
  select p_workspace_id, p_factory_id, result.id, fixture_id from unnest(p_fixture_revision_ids) fixture(fixture_id);
  return result;
end;
$$;

create function public.revoke_factory_benchmark_replay_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_policy_revision_id uuid default null, p_fixture_revision_id uuid default null
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  if num_nonnulls(p_policy_revision_id, p_fixture_revision_id) <> 1 then
    raise exception 'Select exactly one replay revision to revoke.' using errcode = '22023';
  end if;
  if p_policy_revision_id is not null and not exists (
    select 1 from public.factory_benchmark_replay_policy_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_policy_revision_id)
  ) or p_fixture_revision_id is not null and not exists (
    select 1 from public.factory_benchmark_replay_fixture_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_fixture_revision_id)
  ) then
    raise exception 'The replay revision is unavailable in this factory.' using errcode = 'P0002';
  end if;
  insert into internal.factory_benchmark_replay_revocations (
    workspace_id, factory_id, policy_revision_id, fixture_revision_id, revoked_by
  ) values (p_workspace_id, p_factory_id, p_policy_revision_id, p_fixture_revision_id, p_actor_user_id)
  on conflict do nothing;
  return true;
end;
$$;

create function public.open_factory_benchmark_replay_execution(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_execution_id uuid, p_task_revision_id uuid,
  p_policy_revision_id uuid, p_expected_policy_digest text, p_restoration_receipt_sha256 text
) returns public.factory_benchmark_replay_executions
language plpgsql security definer set search_path = '' as $$
declare
  policy public.factory_benchmark_replay_policy_revisions;
  execution public.factory_benchmark_replay_executions;
  selected_task_id uuid;
begin
  perform public.assert_factory_benchmark_replay_access(p_workspace_id, p_factory_id, p_actor_user_id, p_task_revision_id);
  if p_execution_id is null or p_restoration_receipt_sha256 is null or p_restoration_receipt_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Provide an execution identity and an exact restoration receipt.' using errcode = '22023';
  end if;

  select revision.* into policy from public.factory_benchmark_replay_policy_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_policy_revision_id);
  if not found then raise exception 'The replay policy is unavailable in this factory.' using errcode = 'P0002'; end if;
  if p_expected_policy_digest is distinct from policy.policy_digest then
    raise exception 'The replay policy does not match the selected digest.' using errcode = 'PT409';
  end if;
  if exists (select 1 from internal.factory_benchmark_replay_revocations revoked where revoked.policy_revision_id = policy.id) then
    raise exception 'The replay policy was revoked.' using errcode = '42501';
  end if;

  select revision.task_id into selected_task_id from public.factory_benchmark_task_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) = (p_workspace_id, p_factory_id, p_task_revision_id);

  insert into public.factory_benchmark_replay_executions (
    id, workspace_id, factory_id, task_id, task_revision_id, policy_revision_id, policy_digest, profile,
    restoration_receipt_sha256, created_by
  ) values (
    p_execution_id, p_workspace_id, p_factory_id, selected_task_id, p_task_revision_id, policy.id, policy.policy_digest,
    policy.profile, p_restoration_receipt_sha256, p_actor_user_id
  ) on conflict (id) do nothing returning * into execution;
  if found then return execution; end if;

  select prior.* into execution from public.factory_benchmark_replay_executions prior
  where (prior.workspace_id, prior.factory_id, prior.id) = (p_workspace_id, p_factory_id, p_execution_id);
  if not found or (execution.task_revision_id, execution.policy_revision_id, execution.restoration_receipt_sha256, execution.created_by)
    is distinct from (p_task_revision_id, p_policy_revision_id, p_restoration_receipt_sha256, p_actor_user_id) then
    raise exception 'The replay execution identity was already used for different inputs.' using errcode = 'PT409';
  end if;
  return execution;
end;
$$;

create function public.record_factory_benchmark_replay_operation(
  p_workspace_id uuid, p_factory_id uuid, p_execution_id uuid, p_operation_id uuid,
  p_operation public.benchmark_replay_operation, p_fixture_key text default null
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution public.factory_benchmark_replay_executions;
  evidence public.factory_benchmark_replay_operations;
  fixture public.factory_benchmark_replay_fixture_revisions;
  policy_revoked boolean;
  operation_reason text;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_operation_id is null or p_operation is null or (p_fixture_key is not null and p_fixture_key !~ '^[a-f0-9]{64}$') then
    raise exception 'Provide an operation identity and a valid optional fixture fingerprint.' using errcode = '22023';
  end if;
  select opened.* into execution from public.factory_benchmark_replay_executions opened
  where (opened.workspace_id, opened.factory_id, opened.id) = (p_workspace_id, p_factory_id, p_execution_id);
  if not found then raise exception 'The replay execution is unavailable in this factory.' using errcode = 'P0002'; end if;
  -- The same factory lock orders authorization revocation, policy operations and duplicate claims.
  perform public.assert_factory_benchmark_replay_access(p_workspace_id, p_factory_id,
    execution.created_by, execution.task_revision_id);
  select exists (select 1 from internal.factory_benchmark_replay_revocations revoked
    where revoked.policy_revision_id = execution.policy_revision_id) into policy_revoked;

  select recorded.* into evidence from public.factory_benchmark_replay_operations recorded
  where (recorded.workspace_id, recorded.factory_id, recorded.execution_id, recorded.operation_id) =
    (p_workspace_id, p_factory_id, p_execution_id, p_operation_id);
  if found then
    if (evidence.operation, evidence.fixture_key) is distinct from (p_operation, p_fixture_key) then
      raise exception 'The operation identity was already used for different inputs.' using errcode = 'PT409';
    end if;
    if evidence.decision = 'stubbed' then
      select retained.* into fixture from public.factory_benchmark_replay_fixture_revisions retained
      where (retained.workspace_id, retained.factory_id, retained.id, retained.response_sha256) =
        (p_workspace_id, p_factory_id, evidence.fixture_revision_id, evidence.fixture_response_sha256)
        and not exists (select 1 from internal.factory_benchmark_replay_revocations revoked
          where revoked.fixture_revision_id = retained.id);
      if not found or policy_revoked then
        raise exception 'The recorded replay fixture is no longer authorized.' using errcode = '42501';
      end if;
    end if;
  else
    if policy_revoked or execution.profile = 'blocked' then
      operation_reason := 'policy_blocked';
    elsif p_operation = 'external_tool' or (execution.profile = 'recorded_fixtures' and p_operation <> 'tool_read') then
      operation_reason := 'operation_blocked';
    else
      select retained.* into fixture from internal.factory_benchmark_replay_policy_fixtures approved
      join public.factory_benchmark_replay_fixture_revisions retained
        on (retained.workspace_id, retained.factory_id, retained.id) =
          (approved.workspace_id, approved.factory_id, approved.fixture_revision_id)
      where (approved.workspace_id, approved.factory_id, approved.policy_revision_id) =
        (p_workspace_id, p_factory_id, execution.policy_revision_id)
        and (retained.operation, retained.fixture_key) = (p_operation, p_fixture_key);
      if not found then
        operation_reason := 'fixture_unavailable';
      elsif exists (select 1 from internal.factory_benchmark_replay_revocations revoked where revoked.fixture_revision_id = fixture.id) then
        operation_reason := 'fixture_revoked';
        fixture := null;
      else
        operation_reason := 'fixture_matched';
      end if;
    end if;

    insert into public.factory_benchmark_replay_operations (
      workspace_id, factory_id, execution_id, operation_id, operation, fixture_key, decision, reason,
      fixture_revision_id, fixture_response_sha256
    ) values (
      p_workspace_id, p_factory_id, p_execution_id, p_operation_id, p_operation, p_fixture_key,
      case when fixture.id is null then 'denied' else 'stubbed' end, operation_reason, fixture.id, fixture.response_sha256
    ) returning * into evidence;
  end if;

  return jsonb_build_object(
    'executionId', evidence.execution_id, 'operationId', evidence.operation_id, 'operation', evidence.operation,
    'policyRevisionId', execution.policy_revision_id, 'policyDigest', execution.policy_digest, 'fixtureKey', evidence.fixture_key,
    'decision', evidence.decision, 'reason', evidence.reason, 'fixtureRevisionId', evidence.fixture_revision_id,
    'fixtureResponseSha256', evidence.fixture_response_sha256, 'responseJson', fixture.response_json
  );
end;
$$;

revoke all on function
  public.publish_factory_benchmark_replay_fixture(uuid, uuid, uuid, public.benchmark_replay_operation, text, text, uuid),
  public.publish_factory_benchmark_replay_policy(uuid, uuid, uuid, public.benchmark_replay_profile, uuid, uuid[]),
  public.revoke_factory_benchmark_replay_revision(uuid, uuid, uuid, uuid, uuid),
  public.open_factory_benchmark_replay_execution(uuid, uuid, uuid, uuid, uuid, uuid, text, text),
  public.record_factory_benchmark_replay_operation(uuid, uuid, uuid, uuid, public.benchmark_replay_operation, text)
  from public, anon, authenticated, service_role;
grant execute on function
  public.publish_factory_benchmark_replay_fixture(uuid, uuid, uuid, public.benchmark_replay_operation, text, text, uuid),
  public.publish_factory_benchmark_replay_policy(uuid, uuid, uuid, public.benchmark_replay_profile, uuid, uuid[]),
  public.revoke_factory_benchmark_replay_revision(uuid, uuid, uuid, uuid, uuid),
  public.open_factory_benchmark_replay_execution(uuid, uuid, uuid, uuid, uuid, uuid, text, text),
  public.record_factory_benchmark_replay_operation(uuid, uuid, uuid, uuid, public.benchmark_replay_operation, text)
  to service_role;
