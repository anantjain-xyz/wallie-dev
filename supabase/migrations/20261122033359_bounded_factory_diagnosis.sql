-- Diagnosis has its own launcher, lease and terminal receipt. No production
-- job, sandbox, source checkout, tool credential or publication is admitted.
create table internal.factory_diagnoses (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  cohort_id uuid not null,
  symptom_kind text not null,
  request_id uuid not null,
  requested_by_user_id uuid not null,
  requested_by_member_id uuid not null,
  agent_id uuid not null,
  prompt_revision_id uuid not null,
  prompt_sha256 text not null,
  profile_revision_id uuid not null,
  model_id text not null,
  provider_route text not null,
  definition_revision_id uuid not null,
  definition_digest text not null,
  skill_revision_ids uuid[] not null check (cardinality(skill_revision_ids) <= 20),
  member_ids uuid[] not null check (cardinality(member_ids) between 1 and 12),
  evidence jsonb not null check (jsonb_typeof(evidence) = 'array' and jsonb_array_length(evidence) between 1 and 12),
  evidence_digest text not null check (evidence_digest = encode(sha256(convert_to(evidence::text, 'UTF8')), 'hex')),
  minimum_support integer not null check (minimum_support >= 2),
  support_count integer not null check (support_count = cardinality(member_ids)),
  max_input_bytes integer not null default 40000 check (max_input_bytes between 1 and 40000),
  max_output_tokens integer not null default 1200 check (max_output_tokens between 1 and 1200),
  max_execution_ms integer not null default 60000 check (max_execution_ms between 1 and 60000),
  requested_at timestamptz not null default clock_timestamp(),
  status text not null default 'queued' check (status in ('queued', 'claimed', 'running', 'completed',
    'invalid_result', 'provider_unavailable', 'timeout', 'budget_exhausted', 'canceled', 'lease_expired',
    'authorization_revoked', 'evidence_unavailable')),
  attempt_id uuid unique,
  lease_id uuid unique,
  lease_expires_at timestamptz,
  started_at timestamptz,
  deadline_at timestamptz,
  finished_at timestamptz,
  result jsonb,
  trace jsonb,
  usage jsonb,
  unique (workspace_id, factory_id, request_id),
  foreign key (workspace_id, factory_id, cohort_id, symptom_kind)
    references internal.factory_failure_cohorts(workspace_id, factory_id, id, symptom_kind) on delete cascade,
  foreign key (workspace_id, factory_id, agent_id, prompt_revision_id)
    references public.factory_agent_prompt_revisions(workspace_id, factory_id, agent_id, id) on delete cascade,
  foreign key (workspace_id, factory_id, definition_revision_id)
    references public.factory_definition_revisions(workspace_id, factory_id, id) on delete cascade,
  foreign key (workspace_id, profile_revision_id)
    references public.factory_judge_profile_revisions(workspace_id, id) on delete cascade,
  check ((status in ('queued', 'claimed', 'running')) = (finished_at is null)),
  check ((status = 'completed') = (result is not null)),
  check (status <> 'queued' or attempt_id is null),
  check (status not in ('claimed', 'running') or attempt_id is not null),
  check (num_nonnulls(attempt_id, lease_id, lease_expires_at) in (0, 3)),
  check ((started_at is null) = (deadline_at is null)),
  check (deadline_at is null or deadline_at <= lease_expires_at),
  check (status not in ('running', 'completed') or started_at is not null)
);
create unique index factory_diagnoses_one_pending_cohort_idx
  on internal.factory_diagnoses(workspace_id, factory_id, cohort_id)
  where status in ('queued', 'claimed', 'running');
create unique index factory_diagnoses_one_active_workspace_idx
  on internal.factory_diagnoses(workspace_id) where status in ('claimed', 'running');
create index factory_diagnoses_ready_idx on internal.factory_diagnoses(requested_at, id) where status = 'queued';
create index factory_diagnoses_leases_idx on internal.factory_diagnoses(lease_expires_at, id)
  where status in ('claimed', 'running');
create index factory_diagnoses_cohort_idx on internal.factory_diagnoses(workspace_id, factory_id, cohort_id, symptom_kind);
create index factory_diagnoses_prompt_idx on internal.factory_diagnoses(workspace_id, factory_id, agent_id, prompt_revision_id);
create index factory_diagnoses_definition_idx on internal.factory_diagnoses(workspace_id, factory_id, definition_revision_id);
create index factory_diagnoses_profile_idx on internal.factory_diagnoses(workspace_id, profile_revision_id);
alter table internal.factory_diagnoses enable row level security;
revoke all on internal.factory_diagnoses from public, anon, authenticated, service_role;

create function internal.preserve_factory_diagnosis()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.workspaces where id = old.workspace_id)
    or not exists (select 1 from internal.factory_failure_cohorts where id = old.cohort_id)
  ) then return old; end if;
  if tg_op = 'UPDATE' and old.finished_at is null and (
    to_jsonb(new) - array['status','attempt_id','lease_id','lease_expires_at','started_at','deadline_at','finished_at','result','trace','usage']
      = to_jsonb(old) - array['status','attempt_id','lease_id','lease_expires_at','started_at','deadline_at','finished_at','result','trace','usage']
    and (old.attempt_id is null or (new.attempt_id, new.lease_id, new.lease_expires_at)
      is not distinct from (old.attempt_id, old.lease_id, old.lease_expires_at))
    and (old.started_at is null or (new.started_at, new.deadline_at) is not distinct from (old.started_at, old.deadline_at))
  ) then return new; end if;
  raise exception 'Diagnosis history is immutable.' using errcode = '23514';
end;
$$;
create trigger factory_diagnoses_immutable before update or delete on internal.factory_diagnoses
  for each row execute function internal.preserve_factory_diagnosis();

create function internal.factory_diagnosis_sources_current(p_diagnosis internal.factory_diagnoses)
returns boolean language sql stable set search_path = '' as $$
  select cardinality(p_diagnosis.member_ids) = (
    select count(*) from internal.factory_failure_cohorts cohort
    cross join lateral internal.visible_factory_failure_cohort_members(cohort) member
    where (cohort.workspace_id, cohort.factory_id, cohort.id, cohort.symptom_kind) =
      (p_diagnosis.workspace_id, p_diagnosis.factory_id, p_diagnosis.cohort_id, p_diagnosis.symptom_kind)
      and member.id = any(p_diagnosis.member_ids) and internal.factory_failure_member_evidence_state(member) = 'available'
  );
$$;

create function internal.factory_diagnosis_authority_current(p_diagnosis internal.factory_diagnoses)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from public.workspaces workspace
    join public.factories factory on factory.workspace_id = workspace.id
    join public.workspace_members member on member.workspace_id = workspace.id
    join internal.factory_judge_credential_heads profile on profile.workspace_id = workspace.id
    where (workspace.id, factory.id, member.id, member.user_id, profile.profile_revision_id) =
      (p_diagnosis.workspace_id, p_diagnosis.factory_id, p_diagnosis.requested_by_member_id,
       p_diagnosis.requested_by_user_id, p_diagnosis.profile_revision_id)
      and workspace.deletion_requested_at is null and factory.status = 'active' and member.kind = 'human' and member.is_active
      and (member.role in ('owner', 'admin') or exists (
        select 1 from public.factory_members grant_row where (grant_row.workspace_id, grant_row.factory_id, grant_row.member_id) =
          (workspace.id, factory.id, member.id) and grant_row.role = 'manager' and grant_row.revoked_at is null
      ))
  ) and cardinality(p_diagnosis.skill_revision_ids) = (
    select count(*) from public.factory_skill_revisions skill where (skill.workspace_id, skill.factory_id) =
      (p_diagnosis.workspace_id, p_diagnosis.factory_id) and skill.id = any(p_diagnosis.skill_revision_ids) and skill.revoked_at is null
  );
$$;

create function internal.factory_diagnosis_budget(p_diagnosis internal.factory_diagnoses)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('max_input_bytes', p_diagnosis.max_input_bytes, 'max_output_tokens', p_diagnosis.max_output_tokens,
    'max_execution_ms', p_diagnosis.max_execution_ms);
$$;

create function internal.project_factory_diagnosis(p_diagnosis internal.factory_diagnoses)
returns jsonb language sql stable set search_path = '' as $$
  with authority as materialized (select internal.factory_diagnosis_sources_current(p_diagnosis) as visible)
  select jsonb_build_object('diagnosis_id', p_diagnosis.id, 'workspace_id', p_diagnosis.workspace_id,
    'factory_id', p_diagnosis.factory_id, 'cohort_id', p_diagnosis.cohort_id, 'symptom_kind', p_diagnosis.symptom_kind,
    'request_id', p_diagnosis.request_id, 'status', p_diagnosis.status, 'requested_at', p_diagnosis.requested_at,
    'finished_at', p_diagnosis.finished_at, 'requested_by_member_id', p_diagnosis.requested_by_member_id,
    'agent_id', p_diagnosis.agent_id, 'prompt_revision_id', p_diagnosis.prompt_revision_id,
    'prompt_sha256', p_diagnosis.prompt_sha256, 'profile_revision_id', p_diagnosis.profile_revision_id,
    'model_id', p_diagnosis.model_id, 'definition_revision_id', p_diagnosis.definition_revision_id,
    'definition_digest', p_diagnosis.definition_digest, 'skill_revision_ids', p_diagnosis.skill_revision_ids,
    'minimum_support', p_diagnosis.minimum_support, 'support_count', p_diagnosis.support_count,
    'budget', internal.factory_diagnosis_budget(p_diagnosis),
    'evidence_state', case when authority.visible then 'available' else 'unavailable' end,
    'evidence_digest', case when authority.visible then p_diagnosis.evidence_digest end,
    'evidence', case when authority.visible then p_diagnosis.evidence end,
    'result', case when authority.visible then p_diagnosis.result end, 'trace', p_diagnosis.trace, 'usage', p_diagnosis.usage
  ) from authority;
$$;

create function public.request_factory_diagnosis(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_cohort_id uuid, p_request_id uuid, p_prompt_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  requester_id uuid;
  cohort internal.factory_failure_cohorts;
  diagnosis internal.factory_diagnoses;
  prompt public.factory_agent_prompt_revisions;
  profile public.factory_judge_profile_revisions;
  definition public.factory_definition_revisions;
  skills uuid[];
  pinned_members uuid[];
  pinned_evidence jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_request_id is null or p_cohort_id is null or p_prompt_revision_id is null then
    raise exception 'Diagnosis requires a request, cohort and agent prompt revision.' using errcode = '22023';
  end if;
  requester_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  select * into diagnosis from internal.factory_diagnoses existing
  where (existing.workspace_id, existing.factory_id, existing.request_id) = (p_workspace_id, p_factory_id, p_request_id);
  if found then
    if (diagnosis.cohort_id, diagnosis.requested_by_member_id, diagnosis.prompt_revision_id) is distinct from
      (p_cohort_id, requester_id, p_prompt_revision_id) then
      raise exception 'Diagnosis request identity is already in use.' using errcode = 'PT409';
    end if;
    return internal.project_factory_diagnosis(diagnosis);
  end if;
  select * into cohort from internal.factory_failure_cohorts chosen
  where (chosen.workspace_id, chosen.factory_id, chosen.id) = (p_workspace_id, p_factory_id, p_cohort_id);
  if not found then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;
  if exists (
    select 1 from internal.factory_diagnoses existing where (existing.workspace_id, existing.factory_id, existing.cohort_id) =
      (p_workspace_id, p_factory_id, p_cohort_id) and existing.status in ('queued', 'claimed', 'running')
  ) then raise exception 'A diagnosis for this cohort is already pending.' using errcode = 'PT409'; end if;
  select * into prompt from public.factory_agent_prompt_revisions chosen
  where (chosen.workspace_id, chosen.factory_id, chosen.id) = (p_workspace_id, p_factory_id, p_prompt_revision_id);
  if not found then raise exception 'Diagnosis agent prompt revision is unavailable.' using errcode = 'P0002'; end if;
  if octet_length(prompt.prompt_md) > 16000 then
    raise exception 'Diagnosis agent prompt exceeds the execution budget.' using errcode = 'PT422';
  end if;
  select approved.* into profile from internal.factory_judge_credential_heads head
  join public.factory_judge_profile_revisions approved on (approved.workspace_id, approved.id) =
    (head.workspace_id, head.profile_revision_id) where head.workspace_id = p_workspace_id and approved.enabled;
  if not found then raise exception 'An approved inference profile is required.' using errcode = 'PT422'; end if;
  select pinned.* into definition from public.factory_definition_activations activation
  join public.factory_definition_revisions pinned on (pinned.workspace_id, pinned.factory_id, pinned.id) =
    (activation.workspace_id, activation.factory_id, activation.revision_id)
  where (activation.workspace_id, activation.factory_id) = (p_workspace_id, p_factory_id)
  order by activation.activation_number desc limit 1;
  if not found then raise exception 'An active factory definition is required.' using errcode = 'PT422'; end if;
  perform internal.assert_factory_skill_bundle_available(p_workspace_id, p_factory_id, definition.definition_json::jsonb->'skillIds');
  skills := array(select skill.value::uuid from jsonb_array_elements_text(coalesce(definition.definition_json::jsonb->'skillIds', '[]'))
    with ordinality skill(value, position) order by skill.position);

  with one_per_session as materialized (
    select distinct on (member.session_id) member.*
    from internal.visible_factory_failure_cohort_members(cohort) member
    where internal.factory_failure_member_evidence_state(member) = 'available'
    order by member.session_id, member.observed_at desc, member.id
  ), frozen as (
    select * from one_per_session order by observed_at desc, id limit 12
  )
  select array_agg(member.id order by member.observed_at desc, member.id), jsonb_agg(jsonb_build_object(
    'member_id', member.id, 'session_id', member.session_id, 'run_id', member.run_id, 'run_attempt_count', member.run_attempt_count,
    'stage_id', coalesce(manifest.stage_id, run.stage_id), 'stage_slug', run.stage_slug,
    'producing_agent_id', cohort.agent_id, 'agent_prompt_revision_id', member.agent_prompt_revision_id,
    'definition_revision_id', member.definition_revision_id, 'execution_revision_id', member.execution_revision_id,
    'source_kind', member.source_kind, 'evaluation_attempt_id', member.evaluation_attempt_id,
    'scorer_revision_id', member.scorer_revision_id, 'validation_record_key', member.validation_record_key,
    'target_commit_sha', member.target_commit_sha, 'target_tree_sha', member.target_tree_sha
  ) order by member.observed_at desc, member.id) into pinned_members, pinned_evidence
  from frozen member join public.agent_runs run on (run.workspace_id, run.id) = (member.workspace_id, member.run_id)
  left join public.session_attempt_manifests manifest on (manifest.workspace_id, manifest.run_id, manifest.attempt_count) =
    (member.workspace_id, member.run_id, member.run_attempt_count);
  if pinned_members is null then raise exception 'No available evidence can support a diagnosis.' using errcode = 'PT422'; end if;

  insert into internal.factory_diagnoses (workspace_id, factory_id, cohort_id, symptom_kind, request_id,
    requested_by_user_id, requested_by_member_id, agent_id, prompt_revision_id, prompt_sha256, profile_revision_id,
    model_id, provider_route, definition_revision_id, definition_digest, skill_revision_ids, member_ids, evidence,
    evidence_digest, minimum_support, support_count)
  values (p_workspace_id, p_factory_id, p_cohort_id, cohort.symptom_kind, p_request_id, p_actor_user_id, requester_id,
    prompt.agent_id, prompt.id, prompt.prompt_sha256, profile.id, profile.model_id, profile.provider_route,
    definition.id, definition.canonical_digest, skills, pinned_members, pinned_evidence,
    encode(sha256(convert_to(pinned_evidence::text, 'UTF8')), 'hex'), cohort.minimum_support, cardinality(pinned_members))
  returning * into diagnosis;
  return internal.project_factory_diagnosis(diagnosis);
end;
$$;

create function public.claim_factory_diagnosis()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare diagnosis internal.factory_diagnoses;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Serialize only the short selection transaction. Different workspaces
  -- can run provider requests independently after their claims commit.
  if not pg_try_advisory_xact_lock(1401613503, 1) then return null; end if;
  with expired as (
    select job.id from internal.factory_diagnoses job where
      (job.status = 'queued' and job.requested_at + interval '10 minutes' <= clock_timestamp())
      or (job.status in ('claimed', 'running') and job.lease_expires_at <= clock_timestamp())
      or (job.status = 'running' and job.deadline_at <= clock_timestamp())
    order by job.requested_at, job.id limit 32 for update skip locked
  )
  update internal.factory_diagnoses job set status = case when job.status = 'queued'
    or job.deadline_at <= clock_timestamp() then 'timeout' else 'lease_expired' end, finished_at = clock_timestamp()
  from expired where expired.id = job.id;

  select * into diagnosis from internal.factory_diagnoses job where job.status = 'queued'
    and job.requested_at + interval '10 minutes' > clock_timestamp()
    and not exists (select 1 from internal.factory_diagnoses active
      where active.workspace_id = job.workspace_id and active.status in ('claimed', 'running'))
  order by job.requested_at, job.id limit 1 for update of job skip locked;
  if not found then return null; end if;
  update internal.factory_diagnoses job set status = 'claimed', attempt_id = gen_random_uuid(), lease_id = gen_random_uuid(),
    lease_expires_at = clock_timestamp() + interval '90 seconds' where job.id = diagnosis.id returning * into diagnosis;
  return jsonb_build_object('workspace_id', diagnosis.workspace_id, 'factory_id', diagnosis.factory_id,
    'diagnosis_id', diagnosis.id, 'attempt_id', diagnosis.attempt_id, 'lease_id', diagnosis.lease_id,
    'lease_expires_at', diagnosis.lease_expires_at);
end;
$$;

create function public.prepare_factory_diagnosis(
  p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid, p_attempt_id uuid, p_lease_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare diagnosis internal.factory_diagnoses; denied text;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id, job.attempt_id, job.lease_id) =
    (p_workspace_id, p_factory_id, p_diagnosis_id, p_attempt_id, p_lease_id)
    and job.status = 'claimed' and job.lease_expires_at > clock_timestamp() for update;
  if not found then return null; end if;
  if not internal.factory_diagnosis_authority_current(diagnosis) then denied := 'authorization_revoked';
  elsif not internal.factory_diagnosis_sources_current(diagnosis) then denied := 'evidence_unavailable'; end if;
  if denied is not null then
    update internal.factory_diagnoses set status = denied, finished_at = clock_timestamp() where id = diagnosis.id;
    return null;
  end if;
  return (
    select jsonb_build_object('agent_id', diagnosis.agent_id, 'prompt_revision_id', diagnosis.prompt_revision_id,
      'prompt_sha256', diagnosis.prompt_sha256, 'prompt_md', prompt.prompt_md, 'profile_revision_id', diagnosis.profile_revision_id,
      'model_id', diagnosis.model_id, 'provider_route', diagnosis.provider_route, 'definition_revision_id', diagnosis.definition_revision_id,
      'definition_digest', diagnosis.definition_digest, 'skill_revision_ids', diagnosis.skill_revision_ids,
      'minimum_support', diagnosis.minimum_support, 'support_count', diagnosis.support_count, 'symptom_kind', diagnosis.symptom_kind,
      'budget', internal.factory_diagnosis_budget(diagnosis), 'evidence_digest', diagnosis.evidence_digest, 'evidence', diagnosis.evidence)
    from public.factory_agent_prompt_revisions prompt where (prompt.workspace_id, prompt.factory_id, prompt.agent_id, prompt.id) =
      (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.agent_id, diagnosis.prompt_revision_id)
  );
end;
$$;

create function public.begin_factory_diagnosis(
  p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid, p_attempt_id uuid, p_lease_id uuid, p_evidence_digest text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare diagnosis internal.factory_diagnoses; cipher text; denied text; opened_at timestamptz;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id, job.attempt_id, job.lease_id) =
    (p_workspace_id, p_factory_id, p_diagnosis_id, p_attempt_id, p_lease_id)
    and job.status = 'claimed' and job.lease_expires_at > clock_timestamp() and job.evidence_digest = p_evidence_digest;
  if not found then return null; end if;
  -- Manager revocation, skill revocation and session retention use the
  -- workspace/factory fences before the diagnosis row. Match that order.
  begin
    perform internal.assert_factory_manager(diagnosis.workspace_id, diagnosis.factory_id, diagnosis.requested_by_user_id);
  exception when insufficient_privilege or no_data_found then denied := 'authorization_revoked'; end;
  select * into diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id, job.attempt_id, job.lease_id) =
    (p_workspace_id, p_factory_id, p_diagnosis_id, p_attempt_id, p_lease_id)
    and job.status = 'claimed' and job.lease_expires_at > clock_timestamp() and job.evidence_digest = p_evidence_digest for update;
  if not found then return null; end if;
  if denied is not null or not internal.factory_diagnosis_authority_current(diagnosis) then denied := 'authorization_revoked';
  elsif not internal.factory_diagnosis_sources_current(diagnosis) then denied := 'evidence_unavailable'; end if;
  if denied is null then
    select head.encrypted_api_key into cipher from internal.factory_judge_credential_heads head
    where (head.workspace_id, head.profile_revision_id) = (diagnosis.workspace_id, diagnosis.profile_revision_id) for share;
    if not found then denied := 'authorization_revoked'; end if;
  end if;
  if denied is not null then
    update internal.factory_diagnoses set status = denied, finished_at = clock_timestamp() where id = diagnosis.id;
    return null;
  end if;
  opened_at := clock_timestamp();
  if opened_at >= diagnosis.lease_expires_at then return null; end if;
  update internal.factory_diagnoses set status = 'running', started_at = opened_at,
    deadline_at = least(opened_at + max_execution_ms * interval '1 millisecond', lease_expires_at)
  where id = diagnosis.id returning * into diagnosis;
  return jsonb_build_object('encrypted_api_key', cipher, 'deadline_at', diagnosis.deadline_at);
end;
$$;

create function public.is_factory_diagnosis_claim_current(
  p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid, p_attempt_id uuid, p_lease_id uuid
) returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return exists (
    select 1 from internal.factory_diagnoses job where (job.workspace_id, job.factory_id, job.id, job.attempt_id, job.lease_id) =
      (p_workspace_id, p_factory_id, p_diagnosis_id, p_attempt_id, p_lease_id) and job.status = 'running'
      and job.deadline_at > statement_timestamp() and internal.factory_diagnosis_authority_current(job)
      and internal.factory_diagnosis_sources_current(job)
  );
end;
$$;

create function internal.valid_factory_diagnosis_text(p_value jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select (jsonb_typeof(p_value) = 'string' and char_length(btrim(p_value #>> '{}', E' \t\n\r')) between 1 and 640) is true;
$$;

create function internal.valid_factory_diagnosis_result(p_result jsonb, p_member_ids uuid[])
returns boolean language plpgsql immutable set search_path = '' as $$
declare claim jsonb;
begin
  if jsonb_typeof(p_result) is distinct from 'object' or octet_length(p_result::text) > 8192
    or not p_result ?& array['version', 'summary', 'uncertainty', 'claims'] or p_result - array['version','summary','uncertainty','claims'] <> '{}'
    or p_result->'version' is distinct from '1'::jsonb or not internal.valid_factory_diagnosis_text(p_result->'summary')
    or not internal.valid_factory_diagnosis_text(p_result->'uncertainty')
    or jsonb_typeof(p_result->'claims') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_result->'claims') > 8 then return false; end if;
  for claim in select value from jsonb_array_elements(p_result->'claims') loop
    if jsonb_typeof(claim) is distinct from 'object' or not claim ?& array['member_ids','inferred_cause','uncertainty']
      or claim - array['member_ids','inferred_cause','uncertainty'] <> '{}'
      or not internal.valid_factory_diagnosis_text(claim->'inferred_cause') or not internal.valid_factory_diagnosis_text(claim->'uncertainty')
      or jsonb_typeof(claim->'member_ids') is distinct from 'array' then return false; end if;
    if jsonb_array_length(claim->'member_ids') not between 1 and 8 or exists (
      select 1 from jsonb_array_elements(claim->'member_ids') cited(value)
      where jsonb_typeof(cited.value) is distinct from 'string' or not exists (
        select 1 from unnest(p_member_ids) pinned(id) where pinned.id::text = (cited.value #>> '{}')
      )
    ) or jsonb_array_length(claim->'member_ids') <> (
      select count(distinct value) from jsonb_array_elements(claim->'member_ids')
    ) then return false; end if;
  end loop;
  return true;
end;
$$;

create function internal.valid_factory_diagnosis_metadata(p_trace jsonb, p_usage jsonb, p_model_id text)
returns boolean language plpgsql immutable set search_path = '' as $$
declare axis record;
begin
  if p_trace is not null then
    if jsonb_typeof(p_trace) <> 'object' or p_trace - array['provider_model','provider_name','provider_request_id','worker_runtime'] <> '{}'
      or (p_trace ? 'provider_model' and (p_trace->>'provider_model') is distinct from p_model_id)
      or (p_trace ? 'provider_name' and (p_trace->>'provider_name' ~ '^[A-Za-z0-9 ._()/:-]{1,120}$') is not true)
      or (p_trace ? 'provider_request_id' and (p_trace->>'provider_request_id' ~ '^[A-Za-z0-9_-]{1,200}$') is not true)
      or (p_trace ? 'worker_runtime' and (p_trace->>'worker_runtime' in ('node', 'workerd')) is not true) then return false; end if;
    if exists (select 1 from jsonb_each(p_trace) field where jsonb_typeof(field.value) <> 'string') then return false; end if;
  end if;
  if p_usage is not null then
    if jsonb_typeof(p_usage) <> 'object' or p_usage - array['input_tokens', 'output_tokens', 'cost_usd'] <> '{}' then return false; end if;
    for axis in select key, value from jsonb_each(p_usage) loop
      if jsonb_typeof(axis.value) <> 'number' or (axis.value #>> '{}')::numeric not between 0 and 1000000000
        or (axis.key <> 'cost_usd' and trunc((axis.value #>> '{}')::numeric) <> (axis.value #>> '{}')::numeric) then return false; end if;
    end loop;
  end if;
  return true;
end;
$$;

create function public.finish_factory_diagnosis(
  p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid, p_attempt_id uuid, p_lease_id uuid, p_status text,
  p_result jsonb default null, p_trace jsonb default null, p_usage jsonb default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare diagnosis internal.factory_diagnoses; outcome text := p_status;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_status is null or p_status not in ('completed', 'invalid_result', 'provider_unavailable', 'timeout', 'budget_exhausted')
    or (p_status = 'completed') <> (p_result is not null) then
    raise exception 'Invalid diagnosis terminal result.' using errcode = '22023';
  end if;
  select * into diagnosis from internal.factory_diagnoses job
  where (job.workspace_id, job.factory_id, job.id, job.attempt_id, job.lease_id) =
    (p_workspace_id, p_factory_id, p_diagnosis_id, p_attempt_id, p_lease_id) and job.status = 'running'
    and job.lease_expires_at > clock_timestamp() for update;
  if not found then return false; end if;
  if not internal.factory_diagnosis_authority_current(diagnosis) then outcome := 'authorization_revoked';
  elsif not internal.factory_diagnosis_sources_current(diagnosis) then outcome := 'evidence_unavailable';
  elsif diagnosis.deadline_at <= clock_timestamp() then outcome := 'timeout';
  elsif not internal.valid_factory_diagnosis_metadata(p_trace, p_usage, diagnosis.model_id) then
    raise exception 'Invalid diagnosis trace or usage.' using errcode = '22023';
  elsif (p_usage->>'output_tokens')::numeric > diagnosis.max_output_tokens then outcome := 'budget_exhausted';
  elsif p_status = 'completed' and not internal.valid_factory_diagnosis_result(p_result, array(
    select (member.value->>'member_id')::uuid from jsonb_array_elements(diagnosis.evidence) member(value)
    where jsonb_typeof(member.value->'stage_id') = 'string'
  )) then outcome := 'invalid_result';
  end if;
  update internal.factory_diagnoses set status = outcome, finished_at = clock_timestamp(),
    result = case when outcome = 'completed' then p_result end,
    trace = case when internal.valid_factory_diagnosis_metadata(p_trace, p_usage, diagnosis.model_id) then nullif(p_trace, '{}') end,
    usage = case when internal.valid_factory_diagnosis_metadata(p_trace, p_usage, diagnosis.model_id) then nullif(p_usage, '{}') end
  where id = diagnosis.id;
  return true;
end;
$$;

create function public.cancel_factory_diagnosis(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_diagnosis_id uuid
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  update internal.factory_diagnoses job set status = 'canceled', finished_at = clock_timestamp()
  where (job.workspace_id, job.factory_id, job.id) = (p_workspace_id, p_factory_id, p_diagnosis_id)
    and job.status in ('queued', 'claimed', 'running');
  return found;
end;
$$;

create function internal.get_factory_diagnosis(p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, 1);
  return (select internal.project_factory_diagnosis(job) from internal.factory_diagnoses job
    where (job.workspace_id, job.factory_id, job.id) = (p_workspace_id, p_factory_id, p_diagnosis_id));
end;
$$;

create function public.get_factory_diagnosis(p_workspace_id uuid, p_factory_id uuid, p_diagnosis_id uuid)
returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_diagnosis(p_workspace_id, p_factory_id, p_diagnosis_id);
$$;

revoke all on function internal.preserve_factory_diagnosis(), internal.factory_diagnosis_sources_current(internal.factory_diagnoses),
  internal.factory_diagnosis_authority_current(internal.factory_diagnoses), internal.factory_diagnosis_budget(internal.factory_diagnoses),
  internal.project_factory_diagnosis(internal.factory_diagnoses), internal.valid_factory_diagnosis_text(jsonb),
  internal.valid_factory_diagnosis_result(jsonb, uuid[]), internal.valid_factory_diagnosis_metadata(jsonb, jsonb, text),
  internal.get_factory_diagnosis(uuid, uuid, uuid), public.get_factory_diagnosis(uuid, uuid, uuid),
  public.request_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, uuid), public.claim_factory_diagnosis(),
  public.prepare_factory_diagnosis(uuid, uuid, uuid, uuid, uuid), public.begin_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, text),
  public.is_factory_diagnosis_claim_current(uuid, uuid, uuid, uuid, uuid),
  public.finish_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb),
  public.cancel_factory_diagnosis(uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.get_factory_diagnosis(uuid, uuid, uuid), public.get_factory_diagnosis(uuid, uuid, uuid) to authenticated;
grant execute on function public.request_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, uuid), public.claim_factory_diagnosis(),
  public.prepare_factory_diagnosis(uuid, uuid, uuid, uuid, uuid), public.begin_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, text),
  public.is_factory_diagnosis_claim_current(uuid, uuid, uuid, uuid, uuid),
  public.finish_factory_diagnosis(uuid, uuid, uuid, uuid, uuid, text, jsonb, jsonb, jsonb),
  public.cancel_factory_diagnosis(uuid, uuid, uuid, uuid) to service_role;
