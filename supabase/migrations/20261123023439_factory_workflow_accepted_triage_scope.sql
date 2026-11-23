-- Immutable accepted scope
create function internal.preserve_factory_workflow_triage_history()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then return old; end if;
  raise exception 'Triage bindings and accepted scope receipts are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_workflow_triage_history()
  from public, anon, authenticated, service_role;

-- Scratch integration after the foreman migration. A normal specification
-- session is unaffected unless its creation transaction pins a triage graph.
create table internal.factory_workflow_triage_bindings (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  definition_revision_id uuid not null,
  definition_digest text not null,
  graph_revision_id uuid not null,
  workflow_digest text not null,
  stage_id uuid not null,
  prompt_revision_id uuid not null,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade,
  foreign key (workspace_id, factory_id, definition_revision_id, definition_digest, graph_revision_id, workflow_digest)
    references internal.factory_workflow_graph_revisions(workspace_id, factory_id, definition_revision_id,
      definition_digest, id, workflow_digest),
  unique (session_id, workspace_id, factory_id, graph_revision_id, workflow_digest)
);
alter table internal.factory_workflow_triage_bindings enable row level security;
revoke all on internal.factory_workflow_triage_bindings from public, anon, authenticated, service_role;
create trigger preserve_factory_workflow_triage_binding before update or delete
  on internal.factory_workflow_triage_bindings for each row execute function internal.preserve_factory_workflow_triage_history();

create table internal.factory_workflow_accepted_scopes (
  session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  graph_revision_id uuid not null,
  workflow_digest text not null,
  receipt_id uuid not null unique default gen_random_uuid(),
  stage_id uuid not null,
  prompt_revision_id uuid not null,
  approval_id uuid not null,
  artifact_id uuid not null,
  artifact_version integer not null check (artifact_version > 0),
  artifact_digest text not null check (artifact_digest collate "C" ~ '^[a-f0-9]{64}$'),
  job_id uuid not null,
  attempt_count integer not null check (attempt_count > 0),
  run_id uuid not null,
  repository_id uuid not null,
  commit_sha text not null check (commit_sha collate "C" ~ '^[a-f0-9]{40}$'),
  context_manifest_digest text not null check (context_manifest_digest collate "C" ~ '^[a-f0-9]{64}$'),
  scope jsonb not null check (jsonb_typeof(scope) = 'object'),
  recorded_at timestamptz not null default clock_timestamp(),
  foreign key (session_id, workspace_id, factory_id, graph_revision_id, workflow_digest)
    references internal.factory_workflow_triage_bindings(session_id, workspace_id, factory_id, graph_revision_id,
      workflow_digest) on delete cascade
);
alter table internal.factory_workflow_accepted_scopes enable row level security;
revoke all on internal.factory_workflow_accepted_scopes from public, anon, authenticated, service_role;
create trigger preserve_factory_workflow_accepted_scope before update or delete
  on internal.factory_workflow_accepted_scopes for each row execute function internal.preserve_factory_workflow_triage_history();

create function public.bind_factory_workflow_triage(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid, p_workflow_digest text
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  root public.sessions;
  binding internal.factory_workflow_triage_bindings;
  graph internal.factory_workflow_graph_revisions;
  definition jsonb;
  reviewed_stage jsonb;
  gate jsonb;
  plan jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.lock_factory_workflow_root(p_session_id, p_workspace_id, p_factory_id);
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id, pinned.factory_id) =
    (p_session_id, p_workspace_id, p_factory_id);
  if found then
    if (binding.graph_revision_id, binding.workflow_digest) is distinct from (p_graph_revision_id, p_workflow_digest) then
      raise exception 'Triage is already bound to another workflow.' using errcode = 'PT409';
    end if;
    return false;
  end if;

  select session.* into strict root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_session_id, p_workspace_id, p_factory_id);
  -- Intake ordinarily runs in the creation transaction. Lock the first job
  -- here too so a late binding cannot race its ordinary queue claim.
  perform job.id from public.agent_jobs job
  where (job.workspace_id, job.session_id) = (p_workspace_id, p_session_id)
  order by job.id for share;
  if not root.execute_pinned_definition or root.execution_purpose <> 'production'
    or root.phase_status <> 'in_progress' or root.archived_at is not null
    or root.specification_stage_id is null or root.current_stage_id is distinct from root.specification_stage_id
    or exists (select 1 from public.agent_jobs job where (job.workspace_id, job.session_id) =
      (p_workspace_id, p_session_id) and job.attempt_count > 0)
    or exists (select 1 from internal.factory_workflow_delegations child where child.child_session_id = p_session_id)
    or exists (select 1 from internal.factory_workflow_executions execution where execution.root_session_id = p_session_id) then
    raise exception 'Triage must be configured before the first session attempt.' using errcode = 'PT409';
  end if;

  select revision.* into graph
  from public.session_factory_admission_inputs pin
  join internal.factory_workflow_graph_revisions revision
    on (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.definition_digest) =
      (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest)
  where (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.selected_stage_ids) =
    (p_session_id, p_workspace_id, p_factory_id, root.factory_definition_revision_id, array[root.specification_stage_id])
    and (revision.id, revision.workflow_digest) = (p_graph_revision_id, p_workflow_digest);
  if not found then
    raise exception 'Triage requires one selected stage and its configured workflow.' using errcode = 'PT409';
  end if;

  definition := internal.pinned_session_execution_definition(root);
  select stage into reviewed_stage from jsonb_array_elements(definition->'stages') stage
  where stage->>'id' = root.specification_stage_id::text;
  plan := graph.workflow_json::jsonb;
  select node into gate from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';
  if reviewed_stage is null or gate->>'kind' is distinct from 'human-gate'
    or jsonb_typeof(gate->'approverMemberIds') is distinct from 'array'
    or jsonb_typeof(gate->'anyoneCanApprove') is distinct from 'boolean'
    or (definition#>>'{implementationAgent,promptRevisionId}') is null then
    raise exception 'The configured triage workflow requires a matching entry approval gate.' using errcode = 'PT422';
  end if;
  if gate->'anyoneCanApprove' is distinct from reviewed_stage->'anyoneCanApprove'
    or array(select distinct id from jsonb_array_elements_text(gate->'approverMemberIds') member(id) order by id)
      is distinct from array(select distinct id from jsonb_array_elements_text(reviewed_stage->'approverMemberIds') member(id) order by id) then
    raise exception 'The configured triage workflow requires a matching entry approval gate.' using errcode = 'PT422';
  end if;

  insert into internal.factory_workflow_triage_bindings (
    session_id, workspace_id, factory_id, definition_revision_id, definition_digest,
    graph_revision_id, workflow_digest, stage_id, prompt_revision_id
  ) values (p_session_id, p_workspace_id, p_factory_id, graph.definition_revision_id, graph.definition_digest,
    graph.id, graph.workflow_digest, root.specification_stage_id,
    (definition#>>'{implementationAgent,promptRevisionId}')::uuid);
  return true;
end;
$$;

create function internal.escape_triage_scope_markdown(p_text text)
returns text language sql immutable strict set search_path = '' as $$
  select regexp_replace(p_text, '([\\<>`*_\[\]{}!#|~&])', '\\\1', 'g')
$$;

create function internal.is_canonical_factory_triage_text(p_text text, p_max_utf16_units integer)
returns boolean language sql immutable strict set search_path = '' as $$
  -- Match the worker's ECMAScript trim, ASCII control rule, and UTF-16 length.
  select p_text <> ''
    and p_text = btrim(p_text, U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')
    and p_text collate "C" !~ '[[:cntrl:]]'
    and length(p_text) + length(regexp_replace(p_text collate "C", U&'[^\+010000-\+10FFFF]', '', 'g')) <= p_max_utf16_units
$$;

-- The type of the payload, its visible Markdown, and citations must agree.
-- The original frozen context decides which evidence IDs the role saw.
create function internal.decode_factory_workflow_triage_scope(p_artifact_md text, p_manifest jsonb)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  directive text;
  encoded text;
  decoded text;
  payload jsonb;
  criteria_md text;
  evidence_md text;
  canonical text;
begin
  if p_artifact_md is null or octet_length(p_artifact_md) > 16384 then return null; end if;
  directive := split_part(p_artifact_md, E'\n', 1);
  encoded := substring(directive from '^<!-- wallie-accepted-scope: ([A-Za-z0-9_-]+) -->$');
  if encoded is null then return null; end if;
  decoded := convert_from(decode(translate(encoded, '-_', '+/') || repeat('=', (4 - length(encoded) % 4) % 4), 'base64'), 'UTF8');
  if octet_length(decoded) > 12288 or decoded is not json object with unique keys then return null; end if;
  payload := decoded::jsonb;

  if payload - array['version','scope','acceptanceCriteria','evidenceReferences'] <> '{}'::jsonb
    or payload->'version' is distinct from '1'::jsonb
    or jsonb_typeof(payload->'scope') is distinct from 'string'
    or jsonb_typeof(payload->'acceptanceCriteria') is distinct from 'array'
    or jsonb_typeof(payload->'evidenceReferences') is distinct from 'array' then return null; end if;

  if not internal.is_canonical_factory_triage_text(payload->>'scope', 2000)
    or jsonb_array_length(payload->'acceptanceCriteria') not between 1 and 8
    or jsonb_array_length(payload->'evidenceReferences') not between 1 and 8
    or exists (select 1 from jsonb_array_elements(payload->'acceptanceCriteria') criterion
      where jsonb_typeof(criterion) <> 'string' or not internal.is_canonical_factory_triage_text(criterion #>> '{}', 400))
    or exists (select 1 from jsonb_array_elements(payload->'evidenceReferences') reference
      where jsonb_typeof(reference) <> 'string' or length(reference #>> '{}') > 300
        or reference #>> '{}' collate "C" !~ '^[a-zA-Z0-9./:_@-]+$')
    or (select count(distinct item) from jsonb_array_elements(payload->'acceptanceCriteria') item)
      <> jsonb_array_length(payload->'acceptanceCriteria')
    or (select count(distinct item) from jsonb_array_elements(payload->'evidenceReferences') item)
      <> jsonb_array_length(payload->'evidenceReferences') then return null; end if;

  if exists (
    with eligible(ref) as (
      select 'required:' || (item->>'key') from jsonb_array_elements(p_manifest->'required') item
      union all
      select 'document:' || (item->>'sourceId') || ':' || (item->>'revisionId')
      from jsonb_array_elements(p_manifest->'documents') item where item->>'status' = 'selected'
      union all
      select 'conversation:' || (item->>'sequence') from jsonb_array_elements(p_manifest#>'{conversation,messages}') item
      where item ? 'sha256'
      union all
      select 'memory:' || (item->>'memoryId') || ':' || (item->>'revisionId')
      from jsonb_array_elements(p_manifest->'memories') item where item->>'status' = 'selected'
    )
    select 1 from jsonb_array_elements_text(payload->'evidenceReferences') cited(ref)
    where not exists (select 1 from eligible where eligible.ref = cited.ref)
  ) then return null; end if;

  -- Match the worker's canonical wire bytes before issuing a receipt that
  -- later delegated attempts must be able to consume.
  select format('{"acceptanceCriteria":[%s],"evidenceReferences":[%s],"scope":%s,"version":1}',
    (select string_agg(to_json(item)::text, ',' order by position)
      from jsonb_array_elements_text(payload->'acceptanceCriteria') with ordinality criteria(item,position)),
    (select string_agg(to_json(item)::text, ',' order by position)
      from jsonb_array_elements_text(payload->'evidenceReferences') with ordinality evidence(item,position)),
    to_json(payload->>'scope')::text) into canonical;
  if decoded is distinct from canonical or encoded is distinct from rtrim(
    translate(encode(convert_to(canonical, 'UTF8'), 'base64'), E'+/\n', '-_'), '='
  ) then return null; end if;

  select string_agg('- ' || internal.escape_triage_scope_markdown(item), E'\n' order by position)
  into criteria_md from jsonb_array_elements_text(payload->'acceptanceCriteria') with ordinality criteria(item, position);
  select string_agg('- `' || item || '`', E'\n' order by position)
  into evidence_md from jsonb_array_elements_text(payload->'evidenceReferences') with ordinality evidence(item, position);
  if p_artifact_md is distinct from (
    directive || E'\n## Scope\n' || internal.escape_triage_scope_markdown(payload->>'scope')
      || E'\n\n## Acceptance criteria\n' || criteria_md || E'\n\n## Evidence\n' || evidence_md
  ) then return null; end if;
  return payload;
exception when invalid_parameter_value or untranslatable_character or character_not_in_repertoire then
  return null;
end;
$$;

-- The caller owns the root session lock. Return proof from stored evidence only.
create function internal.observe_factory_workflow_accepted_scope(
  p_binding internal.factory_workflow_triage_bindings, p_input_run_id uuid, p_approval_id uuid
) returns internal.factory_workflow_accepted_scopes language plpgsql set search_path = '' as $$
declare
  root public.sessions;
  checkpoint public.session_git_checkpoints;
  artifact public.session_artifacts;
  frozen public.session_run_context_manifests;
  approval public.session_stage_approval_receipts;
  candidate internal.factory_workflow_accepted_scopes;
  plan jsonb;
  gate jsonb;
begin
  select session.* into root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id, session.factory_definition_revision_id,
         session.specification_stage_id, session.current_stage_id) =
    (p_binding.session_id, p_binding.workspace_id, p_binding.factory_id, p_binding.definition_revision_id,
     p_binding.stage_id, p_binding.stage_id)
    and session.execute_pinned_definition and session.execution_purpose = 'production' and session.phase_status = 'approved';
  if not found or exists (
    select 1 from public.session_specification_clarifications clarification
    where (clarification.session_id, clarification.workspace_id, clarification.factory_id, clarification.stage_id) =
      (p_binding.session_id, p_binding.workspace_id, p_binding.factory_id, p_binding.stage_id)
      and clarification.status = 'pending'
  ) then return null; end if;

  perform 1 from public.session_git_heads head
  where (head.session_id, head.workspace_id, head.checkpoint_run_id) =
    (p_binding.session_id, p_binding.workspace_id, p_input_run_id)
  for share;
  if not found then return null; end if;
  checkpoint := internal.factory_workflow_adopted_checkpoint(p_binding.session_id, p_binding.workspace_id,
    p_binding.factory_id, p_binding.definition_revision_id, p_binding.definition_digest, p_input_run_id);
  if checkpoint.run_id is null or checkpoint.artifact_id is distinct from root.current_artifact_id
    or checkpoint.output_kind <> 'no-code' or checkpoint.input_sha is distinct from checkpoint.output_sha then
    return null;
  end if;

  perform 1 from public.agent_runs run
  where (run.id, run.workspace_id, run.session_id, run.agent_job_id, run.attempt_count, run.agent_prompt_revision_id) =
    (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id, checkpoint.attempt_count,
      p_binding.prompt_revision_id);
  if not found then return null; end if;

  select revision.workflow_json::jsonb into plan from internal.factory_workflow_graph_revisions revision
  where (revision.id, revision.workspace_id, revision.factory_id, revision.workflow_digest) =
    (p_binding.graph_revision_id, p_binding.workspace_id, p_binding.factory_id, p_binding.workflow_digest);
  select node into gate from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';
  select receipt.* into approval from public.session_stage_approval_receipts receipt
  where (receipt.id, receipt.session_id, receipt.workspace_id, receipt.stage_id, receipt.artifact_id, receipt.artifact_version) =
    (p_approval_id, p_binding.session_id, p_binding.workspace_id, p_binding.stage_id,
      checkpoint.artifact_id, root.current_artifact_version);
  if not found or gate->>'kind' is distinct from 'human-gate'
    or not internal.factory_workflow_human_approval_passes(root, checkpoint, gate, approval.id) then
    return null;
  end if;

  select stored.* into artifact from public.session_artifacts stored
  where (stored.id, stored.session_id, stored.workspace_id, stored.stage_id, stored.version) =
    (approval.artifact_id, approval.session_id, approval.workspace_id, approval.stage_id, approval.artifact_version);
  if not found or jsonb_typeof(artifact.artifact_json) <> 'string' then return null; end if;
  select manifest.* into frozen from public.session_run_context_manifests manifest
  where (manifest.run_id, manifest.workspace_id, manifest.session_id, manifest.job_id, manifest.attempt_count) =
    (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.job_id, checkpoint.attempt_count);
  if not found then return null; end if;

  candidate.scope := internal.decode_factory_workflow_triage_scope(artifact.artifact_json #>> '{}', frozen.manifest);
  if candidate.scope is null then return null; end if;
  candidate.session_id := p_binding.session_id;
  candidate.workspace_id := p_binding.workspace_id;
  candidate.factory_id := p_binding.factory_id;
  candidate.graph_revision_id := p_binding.graph_revision_id;
  candidate.workflow_digest := p_binding.workflow_digest;
  candidate.stage_id := approval.stage_id;
  candidate.prompt_revision_id := p_binding.prompt_revision_id;
  candidate.approval_id := approval.id;
  candidate.artifact_id := approval.artifact_id;
  candidate.artifact_version := approval.artifact_version;
  candidate.artifact_digest := approval.artifact_digest;
  candidate.job_id := checkpoint.job_id;
  candidate.attempt_count := checkpoint.attempt_count;
  candidate.run_id := checkpoint.run_id;
  candidate.repository_id := checkpoint.repository_id;
  candidate.commit_sha := checkpoint.output_sha;
  candidate.context_manifest_digest := frozen.manifest_sha256;
  return candidate;
end;
$$;

create function public.record_factory_workflow_accepted_scope(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_workflow_digest text, p_input_run_id uuid, p_approval_id uuid
) returns table(receipt_id uuid, created boolean) language plpgsql security definer set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  receipt internal.factory_workflow_accepted_scopes;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.lock_factory_workflow_root(p_session_id, p_workspace_id, p_factory_id);
  select stored.* into binding from internal.factory_workflow_triage_bindings stored
  where (stored.session_id, stored.workspace_id, stored.factory_id, stored.graph_revision_id, stored.workflow_digest) =
    (p_session_id, p_workspace_id, p_factory_id, p_graph_revision_id, p_workflow_digest);
  if not found then
    raise exception 'The workflow does not match the configured triage graph.' using errcode = 'PT409';
  end if;

  select stored.* into receipt from internal.factory_workflow_accepted_scopes stored where stored.session_id = p_session_id;
  if found then
    if (receipt.run_id, receipt.approval_id) is distinct from (p_input_run_id, p_approval_id) then
      raise exception 'Accepted scope was already recorded for another review identity.' using errcode = 'PT409';
    end if;
    return query select receipt.receipt_id, false;
    return;
  end if;

  receipt := internal.observe_factory_workflow_accepted_scope(binding, p_input_run_id, p_approval_id);
  if receipt.session_id is null then return; end if;
  receipt.receipt_id := gen_random_uuid();
  receipt.recorded_at := clock_timestamp();
  insert into internal.factory_workflow_accepted_scopes select (receipt).*;
  return query select receipt.receipt_id, true;
end;
$$;

create function internal.assert_factory_workflow_accepted_scope_enrollment(
  p_binding internal.factory_workflow_triage_bindings, p_graph_revision_id uuid, p_workflow_digest text, p_input_run_id uuid
) returns void language plpgsql set search_path = '' as $$
declare
  saved internal.factory_workflow_accepted_scopes;
  observed internal.factory_workflow_accepted_scopes;
begin
  select stored.* into saved from internal.factory_workflow_accepted_scopes stored
  where (stored.session_id, stored.workspace_id, stored.factory_id, stored.graph_revision_id, stored.workflow_digest, stored.run_id) =
    (p_binding.session_id, p_binding.workspace_id, p_binding.factory_id, p_graph_revision_id, p_workflow_digest, p_input_run_id);
  if found then
    observed := internal.observe_factory_workflow_accepted_scope(p_binding, saved.run_id, saved.approval_id);
    observed.receipt_id := saved.receipt_id;
    observed.recorded_at := saved.recorded_at;
    if observed is not distinct from saved then return; end if;
  end if;
  raise exception 'The configured triage workflow requires its exact currently accepted scope.' using errcode = 'PT409';
end;
$$;

revoke all on function internal.escape_triage_scope_markdown(text),
  internal.is_canonical_factory_triage_text(text,integer),
  internal.decode_factory_workflow_triage_scope(text,jsonb),
  internal.observe_factory_workflow_accepted_scope(internal.factory_workflow_triage_bindings,uuid,uuid),
  internal.assert_factory_workflow_accepted_scope_enrollment(internal.factory_workflow_triage_bindings,uuid,text,uuid),
  public.bind_factory_workflow_triage(uuid,uuid,uuid,uuid,text),
  public.record_factory_workflow_accepted_scope(uuid,uuid,uuid,uuid,text,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.bind_factory_workflow_triage(uuid,uuid,uuid,uuid,text),
  public.record_factory_workflow_accepted_scope(uuid,uuid,uuid,uuid,text,uuid,uuid) to service_role;

-- Check exact scope at graph enrollment
create function internal.factory_workflow_has_validation_evidence(p_requirements jsonb)
returns boolean language sql immutable strict set search_path = '' as $$
  select case when jsonb_typeof(p_requirements->'requiredEvidence') = 'array' then
    jsonb_array_length(p_requirements->'requiredEvidence') > 0 and not exists (
      select 1 from jsonb_array_elements(p_requirements->'requiredEvidence') evidence(key)
      where jsonb_typeof(evidence.key) <> 'string'
        or evidence.key #>> '{}' collate "C" !~
          '^([A-Za-z0-9][A-Za-z0-9._/-]{0,199}|browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99})$'
    ) else false end
$$;
revoke all on function internal.factory_workflow_has_validation_evidence(jsonb)
  from public, anon, authenticated, service_role;

create or replace function public.start_factory_workflow_graph_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_graph_revision_id uuid,
  p_input_run_id uuid default null
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  graph internal.factory_workflow_graph_revisions;
  execution internal.factory_workflow_executions;
  input_job_id uuid;
  input_attempt_count integer;
  input_publication public.session_checkpoint_publications;
  plan jsonb;
  entry jsonb;
  triage internal.factory_workflow_triage_bindings;
begin
  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select revision.* into graph from internal.factory_workflow_graph_revisions revision
    join public.session_factory_admission_inputs pin
      on (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
        (revision.workspace_id, revision.factory_id, revision.definition_revision_id, revision.definition_digest)
    join public.sessions session on session.id = pin.session_id
   where (revision.workspace_id, revision.factory_id, revision.id, pin.session_id) =
     (p_workspace_id, p_factory_id, p_graph_revision_id, p_root_session_id)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id;
  if not found then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if (execution.graph_revision_id, execution.graph_input_run_id) is distinct from (graph.id, p_input_run_id) then
      raise exception 'The root session already has a different workflow or input run.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  if exists (select 1 from internal.factory_workflow_delegations marker
    where (marker.child_session_id, marker.workspace_id, marker.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)) then
    raise exception 'A delegated child cannot start an independent workflow graph.' using errcode = 'PT409';
  end if;
  select binding.* into triage from internal.factory_workflow_triage_bindings binding
  where (binding.session_id, binding.workspace_id, binding.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id);
  if found then
    perform internal.assert_factory_workflow_accepted_scope_enrollment(triage, graph.id, graph.workflow_digest, p_input_run_id);
  elsif exists (select 1 from public.sessions session
    where session.id = p_root_session_id and session.archived_at is not null) then
    raise exception 'The graph revision must match an active session definition pin.' using errcode = 'PT409';
  end if;

  -- Existing command and route capabilities, plus guarded routed child admission.
  plan := graph.workflow_json::jsonb;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node
    where coalesce(node->>'kind', '') not in ('deterministic', 'human-gate', 'route', 'agent')
      or (node->>'kind' = 'deterministic' and coalesce(node->>'operation', '') not in ('validation', 'policy', 'checkpoint'))) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode = 'PT422';
  end if;
  if not internal.is_enrollable_factory_workflow_delegation(p_workspace_id, p_factory_id, plan) then
    raise exception 'The graph requires bounded delegation and exact scoped child profiles.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind' = 'route') then
    if not internal.is_bounded_factory_workflow_route_graph(plan) then
      raise exception 'The graph must match a bounded workflow route policy.' using errcode = 'PT422';
    end if;
    if exists (
      select 1 from jsonb_array_elements(plan->'nodes') node
      where node->>'kind' = 'route' and (
        jsonb_typeof(node->'agentPromptRevisionId') is distinct from 'string'
        or not exists (
          select 1 from public.factory_agent_prompt_revisions prompt
          where (prompt.workspace_id, prompt.factory_id, prompt.id::text) =
            (p_workspace_id, p_factory_id, node->>'agentPromptRevisionId')
        )
      )
    ) then
      raise exception 'The graph requires scoped route prompt revisions.' using errcode = 'PT422';
    end if;
    if not internal.is_enrollable_factory_workflow_foreman(p_workspace_id, p_factory_id, plan) then
      raise exception 'The graph requires a scoped foreman profile and bounded delegation.' using errcode = 'PT422';
    end if;
  elsif not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph must form one next-only path with at most 128 nodes.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'operation' = 'validation')
    and not exists (
      select 1 from public.sessions session
      join public.delivery_policy_revisions policy
        on (policy.id, policy.workspace_id, policy.pipeline_id) =
          (session.pinned_delivery_policy_revision_id, session.workspace_id, session.pipeline_id)
      where session.id = p_root_session_id and internal.factory_workflow_has_validation_evidence(policy.requirements)
    ) then
    raise exception 'The graph requires a pinned delivery policy with valid required evidence.' using errcode = 'PT422';
  end if;
  if p_input_run_id is null and exists (
    select 1 from jsonb_array_elements(plan->'nodes') node
    where node->>'kind' = 'human-gate' or node->>'operation' in ('validation', 'checkpoint')
  ) then
    raise exception 'The graph requires a scoped checkpoint input run.' using errcode = 'PT422';
  end if;
  select node into strict entry from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';

  if p_input_run_id is not null then
    -- Follow the root, job, run, publication lock order used by checkpoint adoption.
    select job.id, job.attempt_count into input_job_id, input_attempt_count
    from public.agent_jobs job
    join public.agent_runs run on (run.agent_job_id, run.session_id, run.workspace_id) =
      (job.id, job.session_id, job.workspace_id)
    where run.id = p_input_run_id and (job.session_id, job.workspace_id) = (p_root_session_id, p_workspace_id)
      and job.attempt_count > 0
    for share of job;

    perform 1 from public.agent_runs run
    where (run.id, run.agent_job_id, run.session_id, run.workspace_id, run.attempt_count) =
      (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
    for share;
    if found then
      select publication.* into input_publication from public.session_checkpoint_publications publication
      where (publication.run_id, publication.job_id, publication.session_id, publication.workspace_id, publication.attempt_count) =
        (p_input_run_id, input_job_id, p_root_session_id, p_workspace_id, input_attempt_count)
      for share;
    end if;
    if input_publication.run_id is null or not (
      input_publication.status = 'adopted'
      or (input_publication.status in ('pending', 'claimed')
        and input_publication.deadline_at > clock_timestamp()
        and internal.checkpoint_publication_is_current(input_publication))
    ) then
      raise exception 'The graph input run has no current scoped checkpoint publication intent.' using errcode = 'PT409';
    end if;
  end if;

  return query
    with enrolled as (
      insert into internal.factory_workflow_executions (
        root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest,
        graph_revision_id, graph_input_run_id, workflow_json, workflow_digest
      ) values (p_root_session_id, p_workspace_id, p_factory_id, graph.definition_revision_id, graph.definition_digest,
        graph.id, p_input_run_id, graph.workflow_json, graph.workflow_digest)
      returning factory_workflow_executions.generation, factory_workflow_executions.ownership_token
    ), admitted as (
      insert into internal.factory_workflow_node_occurrences (
        root_session_id, node_id, node_kind, is_entry, admitted_generation
      ) select p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, enrolled.generation
        from enrolled
      returning occurrence_id
    )
    select enrolled.generation, admitted.occurrence_id, true, enrolled.ownership_token from enrolled cross join admitted;
end;
$$;
create or replace function public.start_factory_workflow_execution(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_definition_revision_id uuid, p_definition_digest text,
  p_workflow_json text, p_workflow_digest text
) returns table (execution_generation bigint, entry_occurrence_id uuid, created boolean, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  plan jsonb := p_workflow_json::jsonb;
  entry jsonb;
  occurrence_id uuid;
begin
  if p_workflow_digest is null or p_workflow_digest <> encode(sha256(convert_to(p_workflow_json, 'UTF8')), 'hex')
    or plan->>'kind' is distinct from 'serial'
    or jsonb_typeof(plan->'nodes') is distinct from 'array'
    or jsonb_typeof(plan->'edges') is distinct from 'array' then
    raise exception 'A verified compiled workflow is required.' using errcode = '22023';
  end if;
  select node into entry from jsonb_array_elements(plan->'nodes') node
   where node->>'id' = plan->>'entryNodeId';
  if entry is null then
    raise exception 'The workflow entry node is missing.' using errcode = '22023';
  end if;

  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  if exists (select 1 from internal.factory_workflow_triage_bindings binding
    where (binding.session_id, binding.workspace_id, binding.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)) then
    raise exception 'A configured triage session requires its pinned graph.' using errcode = 'PT409';
  end if;
  perform 1 from public.session_factory_admission_inputs pin
    join public.sessions session on session.id = pin.session_id
    join public.factory_definition_revisions revision
      on (revision.id, revision.workspace_id, revision.factory_id, revision.canonical_digest) =
        (pin.definition_revision_id, pin.workspace_id, pin.factory_id, pin.definition_digest)
   where (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest) =
     (p_root_session_id, p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest)
     and session.execute_pinned_definition
     and session.factory_definition_revision_id = pin.definition_revision_id
     and internal.matches_serial_factory_workflow_plan(plan, revision.definition_json::jsonb, pin.selected_stage_ids);
  if not found then
    raise exception 'The workflow must match the session definition pin.' using errcode = 'PT409';
  end if;

  select workflow.* into execution
    from internal.factory_workflow_executions workflow
   where workflow.root_session_id = p_root_session_id;
  if found then
    if execution.workflow_digest <> p_workflow_digest or execution.workflow_json <> p_workflow_json then
      raise exception 'The root session already has a different workflow.' using errcode = 'PT409';
    end if;
    return query select execution.generation, occurrence.occurrence_id, false, null::uuid
      from internal.factory_workflow_node_occurrences occurrence
     where occurrence.root_session_id = p_root_session_id and occurrence.is_entry;
    return;
  end if;

  insert into internal.factory_workflow_executions(
    root_session_id, workspace_id, factory_id, definition_revision_id, definition_digest, workflow_json, workflow_digest
  ) values (
    p_root_session_id, p_workspace_id, p_factory_id, p_definition_revision_id, p_definition_digest, p_workflow_json, p_workflow_digest
  ) returning * into execution;

  insert into internal.factory_workflow_node_occurrences(
    root_session_id, node_id, node_kind, is_entry, admitted_generation
  ) values (
    p_root_session_id, entry->>'id', (entry->>'kind')::internal.factory_workflow_node_kind, true, execution.generation
  ) returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  return query select execution.generation, occurrence_id, true, execution.ownership_token;
end;
$$;

-- Versioned intake and M04 approval handoff
-- Applied after accepted-scope.sql and the OP649 enrollment replacements.
create table internal.factory_workflow_triage_configurations (
  workspace_id uuid not null,
  factory_id uuid not null,
  definition_revision_id uuid not null,
  definition_digest text not null,
  configuration_version bigint not null check (configuration_version between 1 and 9007199254740991),
  graph_revision_id uuid not null,
  workflow_digest text not null,
  stage_id uuid not null,
  configured_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, definition_revision_id, configuration_version),
  foreign key (workspace_id, factory_id, definition_revision_id, definition_digest, graph_revision_id, workflow_digest)
    references internal.factory_workflow_graph_revisions(workspace_id, factory_id, definition_revision_id,
      definition_digest, id, workflow_digest) on delete cascade
);
alter table internal.factory_workflow_triage_configurations enable row level security;
revoke all on internal.factory_workflow_triage_configurations from public, anon, authenticated, service_role;
create trigger preserve_factory_workflow_triage_configuration before update or delete
  on internal.factory_workflow_triage_configurations for each row execute function internal.preserve_factory_definition_history();

create function public.configure_factory_workflow_triage(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_definition_revision_id uuid,
  p_graph_revision_id uuid, p_workflow_digest text, p_stage_id uuid, p_expected_version bigint
) returns table(configuration_version bigint, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  actor_member_id uuid;
  configured internal.factory_workflow_triage_configurations;
  registered internal.factory_workflow_graph_revisions;
  definition jsonb;
  gate jsonb;
  stage jsonb;
  plan jsonb;
  current_version bigint;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select prior.* into configured from internal.factory_workflow_triage_configurations prior
  where (prior.workspace_id, prior.factory_id, prior.definition_revision_id) =
    (p_workspace_id, p_factory_id, p_definition_revision_id)
  order by prior.configuration_version desc limit 1;
  current_version := coalesce(configured.configuration_version, 0);
  if configured.configuration_version is not null
    and (configured.graph_revision_id, configured.workflow_digest, configured.stage_id) =
      (p_graph_revision_id, p_workflow_digest, p_stage_id)
    and p_expected_version in (current_version, current_version - 1) then
    return query select current_version, false;
    return;
  end if;
  if p_expected_version is distinct from current_version then
    raise exception 'Triage configuration changed. Reload before saving.' using errcode = 'PT409';
  end if;

  select graph.* into registered from internal.factory_workflow_graph_revisions graph
  where (graph.workspace_id, graph.factory_id, graph.definition_revision_id, graph.id, graph.workflow_digest) =
    (p_workspace_id, p_factory_id, p_definition_revision_id, p_graph_revision_id, p_workflow_digest);
  if not found then raise exception 'The compiled triage graph is unavailable.' using errcode = 'PT404'; end if;
  select revision.definition_json::jsonb into strict definition from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
    (registered.workspace_id, registered.factory_id, registered.definition_revision_id, registered.definition_digest);
  plan := registered.workflow_json::jsonb;
  select node into gate from jsonb_array_elements(plan->'nodes') node where node->>'id' = plan->>'entryNodeId';
  select candidate into stage from jsonb_array_elements(definition->'stages') candidate
  where candidate->>'id' = p_stage_id::text;
  if stage is null or gate->>'kind' is distinct from 'human-gate'
    or gate->'anyoneCanApprove' is distinct from stage->'anyoneCanApprove'
    or jsonb_typeof(gate->'approverMemberIds') is distinct from 'array'
    or definition#>>'{implementationAgent,promptRevisionId}' is null then
    raise exception 'The configured triage stage requires a named agent and matching graph entry gate.' using errcode = 'PT422';
  end if;
  if array(select distinct id from jsonb_array_elements_text(gate->'approverMemberIds') member(id) order by id)
    is distinct from array(select distinct id from jsonb_array_elements_text(stage->'approverMemberIds') member(id) order by id) then
    raise exception 'The configured triage stage requires a named agent and matching graph entry gate.' using errcode = 'PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'operation' = 'validation')
    and not exists (
      select 1 from public.delivery_policy_revisions policy
      where (policy.id::text, policy.workspace_id, policy.pipeline_id::text) =
        (definition->>'deliveryPolicyRevisionId', p_workspace_id, definition->>'pipelineId')
        and internal.factory_workflow_has_validation_evidence(policy.requirements)
    ) then
    raise exception 'The graph requires a pinned delivery policy with valid required evidence.' using errcode = 'PT422';
  end if;

  insert into internal.factory_workflow_triage_configurations (
    workspace_id, factory_id, definition_revision_id, definition_digest, configuration_version,
    graph_revision_id, workflow_digest, stage_id, configured_by_member_id
  ) values (p_workspace_id, p_factory_id, p_definition_revision_id, registered.definition_digest, current_version + 1,
    p_graph_revision_id, p_workflow_digest, p_stage_id, actor_member_id);
  return query select current_version + 1, true;
end;
$$;

alter function public.bind_factory_workflow_triage(uuid,uuid,uuid,uuid,text) set schema internal;
revoke all on function internal.bind_factory_workflow_triage(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- Keep this wrapper at the shared M04 pin used by all source-neutral creation
-- paths. A prior creation receipt returns before any new configuration lookup.
alter function internal.pin_session_specification_stage(public.sessions) rename to pin_session_specification_stage_before_triage;
revoke all on function internal.pin_session_specification_stage_before_triage(public.sessions)
  from public, anon, authenticated, service_role;
create function internal.pin_session_specification_stage(p_session public.sessions)
returns void language plpgsql set search_path = '' as $$
declare
  configured internal.factory_workflow_triage_configurations;
begin
  perform internal.pin_session_specification_stage_before_triage(p_session);
  select configuration.* into configured from public.session_factory_admission_inputs pin
  join internal.factory_workflow_triage_configurations configuration
    on (configuration.workspace_id, configuration.factory_id, configuration.definition_revision_id,
       configuration.definition_digest) = (pin.workspace_id, pin.factory_id, pin.definition_revision_id, pin.definition_digest)
  where (pin.session_id, pin.workspace_id, pin.factory_id) = (p_session.id, p_session.workspace_id, p_session.factory_id)
  order by configuration.configuration_version desc limit 1;
  if not found then return; end if;
  if configured.stage_id is distinct from p_session.current_stage_id then
    raise exception 'Select the configured triage stage for this workflow.' using errcode = 'PT422';
  end if;
  perform internal.bind_factory_workflow_triage(p_session.id, p_session.workspace_id, p_session.factory_id,
    configured.graph_revision_id, configured.workflow_digest);
end;
$$;

create function public.read_factory_workflow_triage_binding(
  p_session_id uuid, p_workspace_id uuid, p_factory_id uuid
) returns table(graph_revision_id uuid, workflow_digest text, stage_id uuid)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return query select binding.graph_revision_id, binding.workflow_digest, binding.stage_id
  from internal.factory_workflow_triage_bindings binding
  where (binding.session_id, binding.workspace_id, binding.factory_id) =
    (p_session_id, p_workspace_id, p_factory_id);
end;
$$;

-- M04 inserted this receipt under its existing workspace/factory/session
-- locks. Complete the deterministic handoff with no inference or network I/O.
create function internal.handoff_factory_workflow_triage_approval()
returns trigger language plpgsql set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  accepted_run_id uuid;
  issued record;
  enrollment record;
  result record;
  admitted record;
  plan jsonb;
  next_edge_id text;
begin
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id) = (new.session_id, new.workspace_id);
  if not found then return new; end if;
  if binding.stage_id is distinct from new.stage_id then
    raise exception 'The review does not match the configured triage stage.' using errcode = 'PT409';
  end if;
  select head.checkpoint_run_id into accepted_run_id from public.session_git_heads head
  join public.session_git_checkpoints checkpoint
    on (checkpoint.run_id, checkpoint.workspace_id, checkpoint.session_id, checkpoint.artifact_id) =
      (head.checkpoint_run_id, head.workspace_id, head.session_id, new.artifact_id)
  where (head.session_id, head.workspace_id) = (new.session_id, new.workspace_id);
  select * into issued from public.record_factory_workflow_accepted_scope(
    binding.session_id, binding.workspace_id, binding.factory_id, binding.graph_revision_id,
    binding.workflow_digest, accepted_run_id, new.id
  );
  if not found then
    raise exception 'Triage scope requires reviewed criteria and exact retained evidence.' using errcode = 'PT422';
  end if;
  select * into strict enrollment from public.start_factory_workflow_graph_execution(
    binding.session_id, binding.workspace_id, binding.factory_id, binding.graph_revision_id, accepted_run_id
  );
  if not enrollment.created then return new; end if;

  select * into result from public.record_factory_workflow_command_result(
    binding.session_id, binding.workspace_id, binding.factory_id, enrollment.execution_generation,
    enrollment.ownership_token, enrollment.entry_occurrence_id, 'human-gate:' || new.id::text
  );
  if not found then
    raise exception 'The exact triage approval did not satisfy the configured gate.' using errcode = 'PT409';
  end if;
  select graph.workflow_json::jsonb into strict plan from internal.factory_workflow_graph_revisions graph
  where (graph.id, graph.workspace_id, graph.factory_id, graph.workflow_digest) =
    (binding.graph_revision_id, binding.workspace_id, binding.factory_id, binding.workflow_digest);
  select edge->>'id' into next_edge_id from jsonb_array_elements(plan->'edges') edge
  where (edge->>'kind', edge->>'from') = ('next', plan->>'entryNodeId');
  if not found then return new; end if;
  select * into admitted from public.admit_factory_workflow_next(
    binding.session_id, binding.workspace_id, binding.factory_id, enrollment.execution_generation,
    enrollment.ownership_token, enrollment.entry_occurrence_id, next_edge_id, result.result_id
  );
  if not found then
    raise exception 'The configured triage successor is unavailable.' using errcode = 'PT409';
  end if;
  return new;
end;
$$;
create trigger handoff_factory_workflow_triage_approval after insert on public.session_stage_approval_receipts
  for each row execute function internal.handoff_factory_workflow_triage_approval();

revoke all on function public.configure_factory_workflow_triage(uuid,uuid,uuid,uuid,uuid,text,uuid,bigint),
  public.read_factory_workflow_triage_binding(uuid,uuid,uuid), internal.pin_session_specification_stage(public.sessions),
  internal.handoff_factory_workflow_triage_approval() from public, anon, authenticated, service_role;
grant execute on function public.configure_factory_workflow_triage(uuid,uuid,uuid,uuid,uuid,text,uuid,bigint),
  public.read_factory_workflow_triage_binding(uuid,uuid,uuid) to service_role;

-- Required input for delegated attempts
-- An immutable child allocation names the scope receipt. Nested allocations
-- retain the root's scope alongside their own immediate parent's checkpoint.
alter table internal.factory_workflow_accepted_scopes add unique (receipt_id, session_id, workspace_id, factory_id);
alter table internal.factory_workflow_delegations add column accepted_scope_receipt_id uuid;
alter table internal.factory_workflow_delegations add constraint delegated_accepted_scope_fk
  foreign key (accepted_scope_receipt_id, root_session_id, workspace_id, factory_id)
  references internal.factory_workflow_accepted_scopes(receipt_id, session_id, workspace_id, factory_id)
  deferrable initially deferred;

create function internal.bind_factory_workflow_delegated_scope() returns trigger
language plpgsql set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  receipt internal.factory_workflow_accepted_scopes;
  execution internal.factory_workflow_executions;
begin
  if new.accepted_scope_receipt_id is not null then
    raise exception 'The delegated scope receipt must be resolved by the allocation.' using errcode = '42501';
  end if;
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id, pinned.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id);
  if not found then return new; end if;

  select workflow.* into strict execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id, workflow.workspace_id, workflow.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id);
  perform internal.assert_factory_workflow_accepted_scope_enrollment(
    binding, execution.graph_revision_id, execution.workflow_digest, execution.graph_input_run_id
  );
  select saved.* into strict receipt from internal.factory_workflow_accepted_scopes saved
  where (saved.session_id, saved.workspace_id, saved.factory_id) = (new.root_session_id, new.workspace_id, new.factory_id);
  if (new.parent_session_id = new.root_session_id and new.source_checkpoint_run_id <> receipt.run_id)
    or (new.parent_session_id <> new.root_session_id and not exists (
      select 1 from internal.factory_workflow_delegations parent
      where (parent.child_session_id, parent.root_session_id, parent.workspace_id, parent.factory_id,
        parent.accepted_scope_receipt_id) =
        (new.parent_session_id, new.root_session_id, new.workspace_id, new.factory_id, receipt.receipt_id)
    )) then
    raise exception 'The delegated source does not match the approved scope lineage.' using errcode = '42501';
  end if;
  new.accepted_scope_receipt_id := receipt.receipt_id;
  return new;
end;
$$;

create trigger bind_factory_workflow_delegated_scope before insert on internal.factory_workflow_delegations
  for each row execute function internal.bind_factory_workflow_delegated_scope();

create function internal.read_factory_workflow_current_scope_artifact(
  p_binding internal.factory_workflow_triage_bindings, p_saved internal.factory_workflow_accepted_scopes
) returns text language plpgsql set search_path = '' as $$
declare
  observed internal.factory_workflow_accepted_scopes;
  artifact_md text;
begin
  observed := internal.observe_factory_workflow_accepted_scope(p_binding, p_saved.run_id, p_saved.approval_id);
  observed.receipt_id := p_saved.receipt_id;
  observed.recorded_at := p_saved.recorded_at;
  if observed is distinct from p_saved then return null; end if;
  select artifact.artifact_json #>> '{}' into artifact_md from public.session_artifacts artifact
  where (artifact.id, artifact.workspace_id, artifact.session_id, artifact.stage_id, artifact.version) =
    (p_saved.artifact_id, p_saved.workspace_id, p_saved.session_id, p_saved.stage_id, p_saved.artifact_version);
  return artifact_md;
end;
$$;

create function public.read_factory_workflow_delegated_scope(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  marker internal.factory_workflow_delegations;
  binding internal.factory_workflow_triage_bindings;
  saved internal.factory_workflow_accepted_scopes;
  owner_job public.agent_jobs;
  artifact_md text;
begin
  perform internal.assert_checkpoint_publication_service();
  select delegated.* into marker from public.agent_jobs job
  join internal.factory_workflow_delegations delegated on (delegated.child_session_id, delegated.workspace_id) =
    (job.session_id, job.workspace_id)
  where (job.id, job.workspace_id) = (p_job_id, p_workspace_id);
  if not found then return jsonb_build_object('status', 'ordinary'); end if;

  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id, pinned.workspace_id, pinned.factory_id) =
    (marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not found and marker.accepted_scope_receipt_id is null then
    return jsonb_build_object('status','ordinary');
  end if;
  if binding.session_id is null or marker.accepted_scope_receipt_id is null then
    raise exception 'The delegated accepted scope pin is unavailable.' using errcode = '42501';
  end if;

  -- Match the release → workspace/factory → root → child/job/run order of start.
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not internal.recheck_factory_workflow_delegation_lineage(
    marker.root_session_id, marker.workspace_id, marker.factory_id, marker.parent_session_id
  ) then
    raise exception 'The delegated scope authority is unavailable.' using errcode = '42501';
  end if;
  owner_job := internal.lock_factory_run_context_attempt(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  if owner_job.session_id is distinct from marker.child_session_id or not exists (
    select 1 from internal.factory_workflow_attempt_reservations hold
    where (hold.root_session_id, hold.workspace_id, hold.factory_id, hold.session_id,
      hold.job_id, hold.attempt_count, hold.run_id) =
      (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id,
        p_job_id, p_attempt_count, p_run_id)
  ) then
    raise exception 'The delegated scope belongs to a different attempt.' using errcode = '42501';
  end if;

  select receipt.* into saved from internal.factory_workflow_accepted_scopes receipt
  where (receipt.receipt_id, receipt.session_id, receipt.workspace_id, receipt.factory_id) =
    (marker.accepted_scope_receipt_id, marker.root_session_id, marker.workspace_id, marker.factory_id);
  if not found then raise exception 'The delegated accepted scope pin is unavailable.' using errcode = '42501'; end if;
  artifact_md := internal.read_factory_workflow_current_scope_artifact(binding,saved);
  if artifact_md is null then
    raise exception 'The delegated accepted scope is no longer current.' using errcode = 'PT409';
  end if;

  return jsonb_build_object(
    'status', 'required', 'receiptId', saved.receipt_id, 'artifactMarkdown', artifact_md, 'pin', jsonb_build_object(
      'workspaceId', saved.workspace_id, 'factoryId', saved.factory_id, 'rootSessionId', saved.session_id,
      'graphRevisionId', saved.graph_revision_id, 'workflowDigest', saved.workflow_digest,
      'promptRevisionId', saved.prompt_revision_id, 'stageId', saved.stage_id,
      'artifactId', saved.artifact_id, 'artifactVersion', saved.artifact_version, 'artifactDigest', saved.artifact_digest,
      'approvalId', saved.approval_id, 'jobId', saved.job_id, 'runId', saved.run_id, 'attemptCount', saved.attempt_count,
      'repositoryId', saved.repository_id, 'commitSha', saved.commit_sha, 'contextManifestDigest', saved.context_manifest_digest
    )
  );
end;
$$;

-- Keep the native context guard authoritative even if a client omits its
-- rendering hook. Earlier sequential retries must retain the same required input.
alter function public.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) set schema internal;
alter function internal.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) rename to pin_factory_run_context_before_triage;
revoke all on function internal.pin_factory_run_context_before_triage(uuid,uuid,uuid,integer,jsonb,uuid)
  from public, anon, authenticated, service_role;
create function public.pin_factory_run_context(
  p_workspace_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer, p_manifest jsonb,
  p_origin_run_id uuid default null
) returns public.session_run_context_manifests language plpgsql security definer set search_path = '' as $$
declare
  scope_input jsonb;
  pin jsonb;
  artifact_md text;
  required_body text;
  required_key text;
  fingerprint jsonb;
begin
  scope_input := public.read_factory_workflow_delegated_scope(p_workspace_id, p_job_id, p_run_id, p_attempt_count);
  if scope_input->>'status' = 'required' then
    pin := scope_input->'pin';
    artifact_md := scope_input->>'artifactMarkdown';
    required_body := substring(artifact_md from strpos(artifact_md, E'\n') + 1);
    required_key := concat_ws('/', 'approved-scope', pin->>'approvalId', pin->>'artifactId',
      pin->>'artifactVersion', pin->>'artifactDigest');
    fingerprint := jsonb_build_object('key', required_key, 'sha256', encode(sha256(convert_to(required_body,'UTF8')),'hex'),
      'utf8Bytes', octet_length(required_body));
    if jsonb_typeof(p_manifest->'required') is distinct from 'array'
      or not coalesce(p_manifest->'required' @> jsonb_build_array(fingerprint), false) then
      raise exception 'The exact approved scope is required in delegated run context.' using errcode = 'PT422';
    end if;
  end if;
  return internal.pin_factory_run_context_before_triage(
    p_workspace_id,p_job_id,p_run_id,p_attempt_count,p_manifest,p_origin_run_id
  );
end;
$$;

revoke all on function internal.bind_factory_workflow_delegated_scope(),
  internal.read_factory_workflow_current_scope_artifact(internal.factory_workflow_triage_bindings,internal.factory_workflow_accepted_scopes),
  public.read_factory_workflow_delegated_scope(uuid,uuid,uuid,integer),
  public.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) from public, anon, authenticated, service_role;
grant execute on function public.read_factory_workflow_delegated_scope(uuid,uuid,uuid,integer),
  public.pin_factory_run_context(uuid,uuid,uuid,integer,jsonb,uuid) to service_role;

-- Durable dispatch of the approved path
-- A single durable work item for the first configured foreman occurrence
-- admitted by the exact acceptance transaction. Provider state and command
-- receipts remain owned by the existing OP648 ledger.
create table internal.factory_workflow_triage_route_dispatches (
  root_session_id uuid primary key,
  workspace_id uuid not null,
  factory_id uuid not null,
  scope_receipt_id uuid not null,
  occurrence_id uuid not null,
  due_at timestamptz not null default clock_timestamp(),
  lease_token uuid unique,
  lease_generation bigint,
  lease_expires_at timestamptz,
  finished_at timestamptz,
  check (num_nonnulls(lease_token, lease_generation, lease_expires_at) in (0, 3)),
  check (finished_at is null or lease_token is null),
  foreign key (root_session_id, occurrence_id)
    references internal.factory_workflow_node_occurrences(root_session_id, occurrence_id) on delete cascade,
  foreign key (scope_receipt_id, root_session_id, workspace_id, factory_id)
    references internal.factory_workflow_accepted_scopes(receipt_id, session_id, workspace_id, factory_id) on delete cascade
);
alter table internal.factory_workflow_triage_route_dispatches enable row level security;
revoke all on internal.factory_workflow_triage_route_dispatches from public, anon, authenticated, service_role;
create index factory_workflow_triage_routes_due on internal.factory_workflow_triage_route_dispatches(due_at, root_session_id)
  where finished_at is null;

create function internal.queue_factory_workflow_accepted_triage_route() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.edge_kind <> 'next' then return new; end if;
  insert into internal.factory_workflow_triage_route_dispatches(root_session_id, workspace_id, factory_id, scope_receipt_id, occurrence_id)
  select saved.session_id, saved.workspace_id, saved.factory_id, saved.receipt_id, route.occurrence_id
  from internal.factory_workflow_accepted_scopes saved
  join internal.factory_workflow_executions execution
    on (execution.root_session_id, execution.workspace_id, execution.factory_id, execution.graph_revision_id,
      execution.workflow_digest, execution.graph_input_run_id) =
      (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id)
  join internal.factory_workflow_node_occurrences gate
    on (gate.root_session_id, gate.occurrence_id, gate.node_kind, gate.is_entry) =
      (saved.session_id, new.source_occurrence_id, 'human-gate', true)
  join internal.factory_workflow_node_results accepted
    on (accepted.root_session_id, accepted.occurrence_id, accepted.result_id, accepted.outcome) =
      (saved.session_id, gate.occurrence_id, new.source_result_id, 'succeeded')
  join internal.factory_workflow_node_occurrences route
    on (route.root_session_id, route.occurrence_id, route.node_kind) =
      (saved.session_id, new.target_occurrence_id, 'route')
  where saved.session_id = new.root_session_id and accepted.evidence_ref = 'human-gate:' || saved.approval_id::text
    and jsonb_typeof(execution.workflow_json::jsonb#>array['routePolicy','nodes',route.node_id,'foremanProfile']) = 'object';
  return new;
end;
$$;
create trigger queue_factory_workflow_accepted_triage_route after insert on internal.factory_workflow_transition_receipts
  for each row execute function internal.queue_factory_workflow_accepted_triage_route();

create function public.claim_factory_workflow_accepted_triage_route(p_candidate_token uuid)
returns table (root_session_id uuid, workspace_id uuid, factory_id uuid, occurrence_id uuid,
  node_id text, workflow_digest text, execution_generation bigint, ownership_token uuid)
language plpgsql security definer set search_path = '' as $$
declare
  pending internal.factory_workflow_triage_route_dispatches;
  binding internal.factory_workflow_triage_bindings;
  saved internal.factory_workflow_accepted_scopes;
  execution internal.factory_workflow_executions;
  adopted record;
  checked_at timestamptz := clock_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  if p_candidate_token is null then return; end if;

  -- A retry after a lost HTTP reply reuses the exact current lease.
  return query
  select queued.root_session_id, queued.workspace_id, queued.factory_id, queued.occurrence_id,
    route.node_id, workflow.workflow_digest, workflow.generation, workflow.ownership_token
  from internal.factory_workflow_triage_route_dispatches queued
  join internal.factory_workflow_executions workflow
    on (workflow.root_session_id, workflow.generation, workflow.ownership_token) =
      (queued.root_session_id, queued.lease_generation, queued.lease_token)
  join internal.factory_workflow_node_occurrences route
    on (route.root_session_id, route.occurrence_id) = (queued.root_session_id, queued.occurrence_id)
  where queued.lease_token = p_candidate_token and queued.lease_expires_at > checked_at;
  if found then return; end if;
  if exists (select 1 from internal.factory_workflow_triage_route_dispatches leased
    where leased.lease_token = p_candidate_token) then return; end if;

  for pending in
    select queued.* from internal.factory_workflow_triage_route_dispatches queued
    join public.workspaces workspace on workspace.id = queued.workspace_id and workspace.deletion_requested_at is null
    join public.factories factory on (factory.id,factory.workspace_id,factory.status) =
      (queued.factory_id,queued.workspace_id,'active')
    join public.sessions root on (root.id,root.workspace_id,root.factory_id,root.phase_status) =
      (queued.root_session_id,queued.workspace_id,queued.factory_id,'approved')
    where queued.finished_at is null and queued.due_at <= checked_at
      and (queued.lease_expires_at is null or queued.lease_expires_at <= checked_at)
    order by queued.due_at, queued.root_session_id limit 12
  loop
    -- Keep the same root-first order as approval, route admission and execution.
    perform 1 from public.workspaces workspace where workspace.id = pending.workspace_id
      and workspace.deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories factory
    where (factory.id,factory.workspace_id,factory.status) = (pending.factory_id,pending.workspace_id,'active')
    for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions root
    where (root.id,root.workspace_id,root.factory_id,root.phase_status) =
      (pending.root_session_id,pending.workspace_id,pending.factory_id,'approved')
    for no key update skip locked;
    if not found then continue; end if;

    select workflow.* into execution from internal.factory_workflow_executions workflow
    where (workflow.root_session_id,workflow.workspace_id,workflow.factory_id) =
      (pending.root_session_id,pending.workspace_id,pending.factory_id)
    for no key update skip locked;
    if not found then continue; end if;
    select queued.* into pending from internal.factory_workflow_triage_route_dispatches queued
    where queued.root_session_id = pending.root_session_id and queued.finished_at is null
      and queued.due_at <= checked_at and (queued.lease_expires_at is null or queued.lease_expires_at <= checked_at)
    for update skip locked;
    if not found then continue; end if;

    -- If a manual owner began the same inference, leave its permit untouched.
    if exists (select 1 from internal.factory_workflow_foreman_runs invocation
      where (invocation.root_session_id,invocation.route_occurrence_id,invocation.status) =
        (pending.root_session_id,pending.occurrence_id,'issued') and invocation.deadline_at > checked_at)
    then continue; end if;

    select pinned.* into strict binding from internal.factory_workflow_triage_bindings pinned
    where (pinned.session_id,pinned.workspace_id,pinned.factory_id) =
      (pending.root_session_id,pending.workspace_id,pending.factory_id);
    select receipt.* into strict saved from internal.factory_workflow_accepted_scopes receipt
    where (receipt.receipt_id,receipt.session_id,receipt.graph_revision_id,receipt.workflow_digest,receipt.run_id) =
      (pending.scope_receipt_id,pending.root_session_id,execution.graph_revision_id,execution.workflow_digest,execution.graph_input_run_id);
    if internal.read_factory_workflow_current_scope_artifact(binding,saved) is null then
      update internal.factory_workflow_triage_route_dispatches queued
      set due_at = clock_timestamp() + interval '30 seconds' where queued.root_session_id = pending.root_session_id;
      continue;
    end if;

    select * into adopted from public.acquire_factory_workflow_ownership(pending.root_session_id,pending.workspace_id,
      pending.factory_id,execution.generation,p_candidate_token);
    if not found then continue; end if;
    update internal.factory_workflow_triage_route_dispatches queued
    set lease_token = adopted.ownership_token, lease_generation = adopted.execution_generation,
      lease_expires_at = clock_timestamp() + interval '90 seconds'
    where queued.root_session_id = pending.root_session_id;
    return query select pending.root_session_id,pending.workspace_id,pending.factory_id,pending.occurrence_id,
      route.node_id,execution.workflow_digest,adopted.execution_generation,adopted.ownership_token
    from internal.factory_workflow_node_occurrences route
    where (route.root_session_id,route.occurrence_id) = (pending.root_session_id,pending.occurrence_id);
    return;
  end loop;
end;
$$;

create function public.finish_factory_workflow_accepted_triage_route(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_occurrence_id uuid,
  p_expected_generation bigint, p_ownership_token uuid, p_completed boolean
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if p_completed is null then return false; end if;
  perform internal.lock_factory_workflow_owner(
    p_root_session_id,p_workspace_id,p_factory_id,p_expected_generation,p_ownership_token
  );

  -- Durable accepted commands win over an early terminal observation. A
  -- recorded blocked command is terminal and can leave later ordinals empty.
  update internal.factory_workflow_triage_route_dispatches queued
  set finished_at = case when p_completed and (
      not exists (select 1 from internal.factory_workflow_foreman_commands command
        where (command.root_session_id,command.route_occurrence_id) = (p_root_session_id,p_occurrence_id)
          and command.receipt_json is null)
      or exists (select 1 from internal.factory_workflow_foreman_commands command
        where (command.root_session_id,command.route_occurrence_id) = (p_root_session_id,p_occurrence_id)
          and command.receipt_json->>'status' = 'blocked')
    ) then clock_timestamp() end,
    due_at = clock_timestamp() + interval '15 seconds', lease_token = null, lease_generation = null, lease_expires_at = null
  where (queued.root_session_id,queued.workspace_id,queued.factory_id,queued.occurrence_id,
    queued.lease_generation,queued.lease_token) =
    (p_root_session_id,p_workspace_id,p_factory_id,p_occurrence_id,p_expected_generation,p_ownership_token)
    and queued.lease_expires_at > clock_timestamp();
  return found;
exception when sqlstate 'PT409' then return false;
end;
$$;

revoke all on function internal.queue_factory_workflow_accepted_triage_route(),
  public.claim_factory_workflow_accepted_triage_route(uuid),
  public.finish_factory_workflow_accepted_triage_route(uuid,uuid,uuid,uuid,bigint,uuid,boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.claim_factory_workflow_accepted_triage_route(uuid),
  public.finish_factory_workflow_accepted_triage_route(uuid,uuid,uuid,uuid,bigint,uuid,boolean) to service_role;

-- Keep the existing inference issuance contract and provider. The task input
-- for a triage graph comes from the retained accepted scope, not intake prose.
alter function public.begin_factory_workflow_foreman_inference(uuid,uuid,uuid,bigint,uuid,uuid) set schema internal;
alter function internal.begin_factory_workflow_foreman_inference(uuid,uuid,uuid,bigint,uuid,uuid)
  rename to begin_factory_workflow_foreman_inference_before_triage;
revoke all on function internal.begin_factory_workflow_foreman_inference_before_triage(uuid,uuid,uuid,bigint,uuid,uuid)
  from public, anon, authenticated, service_role;
create function public.begin_factory_workflow_foreman_inference(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint, p_ownership_token uuid,
  p_route_occurrence_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  binding internal.factory_workflow_triage_bindings;
  saved internal.factory_workflow_accepted_scopes;
  execution internal.factory_workflow_executions;
  artifact_md text;
  approved_scope text;
  response jsonb;
begin
  select pinned.* into binding from internal.factory_workflow_triage_bindings pinned
  where (pinned.session_id,pinned.workspace_id,pinned.factory_id) = (p_root_session_id,p_workspace_id,p_factory_id);
  if found then
    execution := internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,
      p_expected_generation,p_ownership_token);
    select receipt.* into saved from internal.factory_workflow_accepted_scopes receipt
    where (receipt.session_id,receipt.workspace_id,receipt.factory_id,
      receipt.graph_revision_id,receipt.workflow_digest,receipt.run_id) =
      (p_root_session_id,p_workspace_id,p_factory_id,
        execution.graph_revision_id,execution.workflow_digest,execution.graph_input_run_id);
    if not found then return jsonb_build_object('status','blocked','code','root_unavailable'); end if;
    artifact_md := internal.read_factory_workflow_current_scope_artifact(binding,saved);
    if artifact_md is null then return jsonb_build_object('status','blocked','code','root_unavailable'); end if;
    approved_scope := substring(artifact_md from strpos(artifact_md,E'\n') + 1);
    if octet_length(approved_scope) > 12000 then
      return jsonb_build_object('status','blocked','code','root_unavailable');
    end if;
  end if;
  response := internal.begin_factory_workflow_foreman_inference_before_triage(p_root_session_id,p_workspace_id,
    p_factory_id,p_expected_generation,p_ownership_token,p_route_occurrence_id);
  if approved_scope is not null and response->>'status' = 'issued' then
    response := jsonb_set(response,'{taskPromptMd}',to_jsonb(approved_scope));
  end if;
  return response;
end;
$$;
revoke all on function public.begin_factory_workflow_foreman_inference(uuid,uuid,uuid,bigint,uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.begin_factory_workflow_foreman_inference(uuid,uuid,uuid,bigint,uuid,uuid)
  to service_role;
