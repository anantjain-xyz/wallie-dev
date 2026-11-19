alter type public.session_conversation_author_kind add value 'service';
create type public.factory_session_mutation_operation as enum ('create', 'follow_up', 'answer_clarification', 'cancel');

create type internal.session_mutation_actor as (
  workspace_id uuid,
  factory_id uuid,
  member_id uuid,
  service_principal_id uuid,
  consenting_member_id uuid,
  grant_id uuid,
  grant_version bigint,
  writer_repository_id uuid,
  admission_id uuid
);
revoke all on type internal.session_mutation_actor from public, anon, authenticated, service_role;

-- These receipts are business idempotency. They live with their session and
-- are independent of the short-lived transport permit and its retention.
create table internal.session_mutation_receipts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  operation public.factory_session_mutation_operation not null,
  request_id uuid not null,
  intent_hash text not null check (intent_hash ~ '^[a-f0-9]{64}$'),
  session_id uuid not null,
  writer_repository_id uuid,
  grant_id uuid,
  grant_version bigint,
  actor_member_id uuid,
  actor_service_principal_id uuid,
  consenting_member_id uuid,
  admission_id uuid,
  result jsonb not null check (jsonb_typeof(result) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, operation, request_id),
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  check ((grant_id is null) = (grant_version is null)),
  check ((actor_member_id is null) <> (actor_service_principal_id is null)),
  check (actor_service_principal_id is null or grant_id is not null),
  check ((actor_service_principal_id is null) = (admission_id is null)),
  check (consenting_member_id is null or actor_service_principal_id is not null)
);
create index session_mutation_receipts_session_idx on internal.session_mutation_receipts(session_id);
alter table internal.session_mutation_receipts enable row level security;
revoke all on internal.session_mutation_receipts from public, anon, authenticated, service_role;

create function internal.session_mutation_scope(p_operation public.factory_session_mutation_operation)
returns public.factory_command_scope language sql immutable strict set search_path = '' as $$
  select case p_operation
    when 'create' then 'sessions:create'
    when 'follow_up' then 'sessions:follow-up'
    when 'answer_clarification' then 'sessions:clarify'
    when 'cancel' then 'sessions:cancel'
  end::public.factory_command_scope;
$$;

create function internal.lock_session_mutation_key(
  p_workspace_id uuid, p_factory_id uuid, p_operation public.factory_session_mutation_operation, p_request_id uuid
) returns void language plpgsql set search_path = '' as $$
begin
  if p_workspace_id is null or p_factory_id is null or p_operation is null or p_request_id is null then
    raise exception 'A complete session operation and request identity is required.' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-mutation:' || p_workspace_id::text || ':' || p_factory_id::text || ':'
      || p_operation::text || ':' || p_request_id::text, 0));
end;
$$;

create function internal.assert_session_mutation_actor(
  p_actor internal.session_mutation_actor, p_operation public.factory_session_mutation_operation
) returns void language plpgsql set search_path = '' as $$
declare approved public.factory_execution_grants;
begin
  if (p_actor.grant_id is null) <> (p_actor.grant_version is null) then
    raise exception 'An exact grant version is required.' using errcode = '42501';
  end if;
  if p_actor.member_id is not null then
    if p_actor.service_principal_id is not null or p_actor.admission_id is not null or p_actor.consenting_member_id is not null then
      raise exception 'The session request actor is invalid.' using errcode = '42501';
    end if;
    perform internal.assert_session_command_access(p_actor.workspace_id, p_actor.factory_id, p_actor.member_id);
  elsif not exists (
    select 1 from internal.factory_command_admissions admission
    join internal.factory_command_leases lease on lease.admission_id = admission.id
    where (admission.id, admission.workspace_id, admission.factory_id, admission.service_principal_id,
      admission.execution_grant_id, admission.execution_grant_version, admission.scope, lease.verified_transaction) =
      (p_actor.admission_id, p_actor.workspace_id, p_actor.factory_id, p_actor.service_principal_id,
        p_actor.grant_id, p_actor.grant_version, internal.session_mutation_scope(p_operation), pg_current_xact_id())
      and admission.consenting_member_id is not distinct from p_actor.consenting_member_id
  ) then
    raise exception 'The session command admission is unavailable.' using errcode = '42501';
  end if;

  if p_actor.grant_id is not null and (p_actor.service_principal_id is not null or p_operation <> 'cancel') then
    approved := internal.require_factory_machine_grant(
      p_actor.workspace_id, p_actor.factory_id, p_actor.grant_id, p_actor.grant_version);
    if approved.github_repository_id is distinct from p_actor.writer_repository_id
      or (p_actor.service_principal_id is not null and approved.service_principal_id <> p_actor.service_principal_id) then
      raise exception 'The session command does not match the approved execution grant.' using errcode = '42501';
    end if;
  end if;
end;
$$;

create function internal.session_mutation_human_actor(
  p_workspace_id uuid, p_factory_id uuid, p_member_id uuid, p_session_id uuid
) returns internal.session_mutation_actor language plpgsql set search_path = '' as $$
declare target public.sessions; admitted public.session_factory_admission_inputs;
begin
  perform internal.assert_session_command_access(p_workspace_id, p_factory_id, p_member_id);
  select * into target from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_session_id, p_workspace_id, p_factory_id);
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  select * into admitted from public.session_factory_admission_inputs receipt
  where (receipt.session_id, receipt.workspace_id, receipt.factory_id, receipt.github_repository_id) =
    (target.id, target.workspace_id, target.factory_id, target.github_repository_id);
  return row(p_workspace_id, p_factory_id, p_member_id, null, null,
    admitted.execution_grant_id, admitted.execution_grant_version, target.github_repository_id, null
  )::internal.session_mutation_actor;
end;
$$;

create function internal.lock_machine_session_mutation_target(
  p_actor internal.session_mutation_actor, p_session_id uuid
) returns public.sessions language plpgsql set search_path = '' as $$
declare target public.sessions;
begin
  select session.* into target from public.sessions session
  join public.session_factory_admission_inputs admitted on
    (admitted.session_id, admitted.workspace_id, admitted.factory_id, admitted.github_repository_id) =
    (session.id, session.workspace_id, session.factory_id, session.github_repository_id)
  where (session.id, session.workspace_id, session.factory_id, session.github_repository_id,
    admitted.execution_grant_id, admitted.execution_grant_version, admitted.credential_owner_service_principal_id) =
    (p_session_id, p_actor.workspace_id, p_actor.factory_id, p_actor.writer_repository_id,
      p_actor.grant_id, p_actor.grant_version, p_actor.service_principal_id)
    and session.execute_pinned_definition
  for no key update of session;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  return target;
end;
$$;

create function internal.find_session_mutation_receipt(
  p_actor internal.session_mutation_actor, p_operation public.factory_session_mutation_operation,
  p_request_id uuid, p_intent jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare accepted internal.session_mutation_receipts;
begin
  perform internal.assert_session_mutation_actor(p_actor, p_operation);
  perform internal.lock_session_mutation_key(p_actor.workspace_id, p_actor.factory_id, p_operation, p_request_id);
  select * into accepted from internal.session_mutation_receipts receipt
  where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id) =
    (p_actor.workspace_id, p_actor.factory_id, p_operation, p_request_id);
  if not found then return null; end if;

  if (accepted.writer_repository_id, accepted.grant_id, accepted.grant_version)
    is distinct from (p_actor.writer_repository_id, p_actor.grant_id, p_actor.grant_version)
    or (accepted.grant_id is null and accepted.actor_member_id is distinct from p_actor.member_id)
    or accepted.intent_hash is distinct from encode(extensions.digest(convert_to(p_intent::text, 'UTF8'), 'sha256'), 'hex') then
    raise exception 'The session request identity was already used for different input.' using errcode = 'P0005';
  end if;
  perform 1 from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (accepted.session_id, p_actor.workspace_id, p_actor.factory_id)
    and session.github_repository_id is not distinct from p_actor.writer_repository_id
  for key share;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;
  return accepted.result || jsonb_build_object('replayed', true);
end;
$$;

create function internal.record_session_mutation_receipt(
  p_actor internal.session_mutation_actor, p_operation public.factory_session_mutation_operation,
  p_request_id uuid, p_intent jsonb, p_session_id uuid, p_result jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare result jsonb; receipt_id uuid := gen_random_uuid();
begin
  perform internal.assert_session_mutation_actor(p_actor, p_operation);
  perform internal.lock_session_mutation_key(p_actor.workspace_id, p_actor.factory_id, p_operation, p_request_id);
  select p_result || jsonb_build_object(
    'receiptId', receipt_id, 'sessionId', session.id, 'sessionNumber', session.number,
    'workspaceSlug', workspace.slug, 'phaseStatus', session.phase_status, 'replayed', false
  ) into result from public.sessions session
  join public.workspaces workspace on workspace.id = session.workspace_id
  where (session.id, session.workspace_id, session.factory_id) = (p_session_id, p_actor.workspace_id, p_actor.factory_id)
    and session.github_repository_id is not distinct from p_actor.writer_repository_id;
  if not found then raise exception 'Session not found.' using errcode = 'PT404'; end if;

  insert into internal.session_mutation_receipts (
    id, workspace_id, factory_id, operation, request_id, intent_hash, session_id, writer_repository_id,
    grant_id, grant_version, actor_member_id, actor_service_principal_id, consenting_member_id, admission_id, result
  ) values (
    receipt_id, p_actor.workspace_id, p_actor.factory_id, p_operation, p_request_id,
    encode(extensions.digest(convert_to(p_intent::text, 'UTF8'), 'sha256'), 'hex'),
    p_session_id, p_actor.writer_repository_id, p_actor.grant_id, p_actor.grant_version,
    p_actor.member_id, p_actor.service_principal_id, p_actor.consenting_member_id, p_actor.admission_id, result
  );
  return result;
end;
$$;

revoke all on function
  internal.session_mutation_scope(public.factory_session_mutation_operation),
  internal.lock_session_mutation_key(uuid, uuid, public.factory_session_mutation_operation, uuid),
  internal.assert_session_mutation_actor(internal.session_mutation_actor, public.factory_session_mutation_operation),
  internal.session_mutation_human_actor(uuid, uuid, uuid, uuid),
  internal.lock_machine_session_mutation_target(internal.session_mutation_actor, uuid),
  internal.find_session_mutation_receipt(internal.session_mutation_actor, public.factory_session_mutation_operation, uuid, jsonb),
  internal.record_session_mutation_receipt(internal.session_mutation_actor, public.factory_session_mutation_operation, uuid, jsonb, uuid, jsonb)
from public, anon, authenticated, service_role;
