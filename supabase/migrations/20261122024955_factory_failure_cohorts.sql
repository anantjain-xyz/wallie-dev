-- Stable group identity and immutable source references. Read-time qualification
-- reflects currently accessible evidence and preserves each producing version.
create table internal.factory_failure_cohorts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  task_class_slug text,
  unclassified_scope_id uuid,
  agent_id uuid not null,
  symptom_kind text not null check (symptom_kind in ('scorer', 'validation')),
  symptom_key text not null,
  minimum_support integer not null default 3 check (minimum_support >= 2),
  created_at timestamptz not null default clock_timestamp(),
  check ((task_class_slug is null) <> (unclassified_scope_id is null)),
  unique (workspace_id, factory_id, id, symptom_kind),
  unique nulls not distinct (workspace_id, factory_id, task_class_slug, unclassified_scope_id,
    agent_id, symptom_kind, symptom_key),
  foreign key (workspace_id, factory_id, agent_id)
    references public.factory_agents (workspace_id, factory_id, id) on delete cascade
);
create index factory_failure_cohorts_access_idx
  on internal.factory_failure_cohorts (workspace_id, factory_id, id);

create table internal.factory_failure_cohort_members (
  id uuid primary key default gen_random_uuid(),
  cohort_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid not null,
  run_id uuid not null references public.agent_runs (id) on delete cascade,
  run_attempt_count integer not null check (run_attempt_count > 0),
  definition_revision_id uuid,
  definition_digest text,
  execution_revision_id uuid,
  execution_digest text,
  agent_prompt_revision_id uuid not null,
  model_provider text not null,
  model_name text not null,
  source_kind text not null,
  evaluation_attempt_id uuid references public.factory_evaluation_receipts (attempt_id) on delete cascade,
  evaluation_job_id uuid,
  scorer_revision_id uuid,
  validation_run_id uuid references public.session_validation_evidence (run_id) on delete cascade,
  validation_record_key text,
  target_commit_sha text not null,
  target_tree_sha text,
  observed_at timestamptz not null,
  check ((definition_revision_id is null) = (definition_digest is null)),
  check ((execution_revision_id is null) = (execution_digest is null)),
  check (
    (source_kind = 'scorer' and num_nonnulls(evaluation_attempt_id, evaluation_job_id, scorer_revision_id) = 3
      and num_nonnulls(validation_run_id, validation_record_key, target_tree_sha) = 0)
    or (source_kind = 'validation' and validation_run_id = run_id
      and num_nonnulls(validation_run_id, validation_record_key, target_tree_sha) = 3
      and num_nonnulls(evaluation_attempt_id, evaluation_job_id, scorer_revision_id) = 0)
  ),
  unique nulls not distinct (run_id, evaluation_attempt_id, validation_record_key),
  foreign key (workspace_id, factory_id, cohort_id, source_kind)
    references internal.factory_failure_cohorts (workspace_id, factory_id, id, symptom_kind) on delete cascade,
  foreign key (session_id, workspace_id, factory_id)
    references public.sessions (id, workspace_id, factory_id) on delete cascade
);
create index factory_failure_cohort_members_page_idx
  on internal.factory_failure_cohort_members (workspace_id, factory_id, cohort_id, source_kind, id);
create index factory_failure_cohort_members_session_idx
  on internal.factory_failure_cohort_members (session_id, workspace_id, factory_id);
create index factory_failure_cohort_members_evaluation_idx
  on internal.factory_failure_cohort_members (evaluation_attempt_id) where evaluation_attempt_id is not null;
create index factory_failure_cohort_members_validation_idx
  on internal.factory_failure_cohort_members (validation_run_id) where validation_run_id is not null;

create table internal.factory_failure_cohort_backfill (
  source_kind text primary key check (source_kind in ('scorer', 'validation')),
  last_source_id uuid,
  completed boolean not null default false
);
insert into internal.factory_failure_cohort_backfill (source_kind) values ('scorer'), ('validation');

create table internal.factory_failure_cohort_inbox (
  sequence bigint generated always as identity primary key,
  source_kind text not null check (source_kind in ('scorer', 'validation')),
  source_id uuid not null,
  unique (source_kind, source_id)
);

alter table internal.factory_failure_cohorts enable row level security;
alter table internal.factory_failure_cohort_members enable row level security;
alter table internal.factory_failure_cohort_backfill enable row level security;
alter table internal.factory_failure_cohort_inbox enable row level security;
revoke all on internal.factory_failure_cohorts, internal.factory_failure_cohort_members,
  internal.factory_failure_cohort_backfill, internal.factory_failure_cohort_inbox
  from public, anon, authenticated, service_role;

create function internal.guard_factory_failure_cohort()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factory_agents agent where (agent.workspace_id, agent.factory_id, agent.id) =
      (old.workspace_id, old.factory_id, old.agent_id)
  ) then return old; end if;
  raise exception 'Failure cohort identities are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_failure_cohorts_immutable before update or delete
  on internal.factory_failure_cohorts for each row execute function internal.guard_factory_failure_cohort();

create function internal.guard_factory_failure_cohort_member()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from internal.factory_failure_cohorts cohort where cohort.id = old.cohort_id)
    or not exists (select 1 from public.sessions owner where owner.id = old.session_id)
    or not exists (select 1 from public.agent_runs run where run.id = old.run_id)
    or (old.evaluation_attempt_id is not null and not exists (
      select 1 from public.factory_evaluation_receipts receipt where receipt.attempt_id = old.evaluation_attempt_id))
    or (old.validation_run_id is not null and not exists (
      select 1 from public.session_validation_evidence evidence where evidence.run_id = old.validation_run_id))
  ) then return old; end if;
  raise exception 'Failure cohort memberships are immutable.' using errcode = '23514';
end;
$$;
create trigger factory_failure_cohort_members_immutable before update or delete
  on internal.factory_failure_cohort_members for each row execute function internal.guard_factory_failure_cohort_member();

create function internal.record_factory_failure_cohort_member(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_run_id uuid, p_run_attempt_count integer,
  p_source_kind text, p_symptom_key text, p_observed_at timestamptz, p_target_commit_sha text,
  p_evaluation_attempt_id uuid default null, p_evaluation_job_id uuid default null, p_scorer_revision_id uuid default null,
  p_validation_record_key text default null, p_target_tree_sha text default null
) returns void language plpgsql set search_path = '' as $$
declare
  identity record;
  matched_cohort_id uuid;
begin
  if exists (
    select 1 from internal.factory_failure_cohort_members member
    where member.run_id = p_run_id and member.evaluation_attempt_id is not distinct from p_evaluation_attempt_id
      and member.validation_record_key is not distinct from p_validation_record_key
  ) then return; end if;

  select run.agent_id, run.agent_prompt_revision_id,
    coalesce(manifest.model_provider, run.model_provider) as model_provider,
    coalesce(manifest.model_name, run.model_name) as model_name,
    definition.id as definition_revision_id, definition.canonical_digest as definition_digest,
    case when routing.receipt is not null then routed.id else definition.id end as execution_revision_id,
    case when routing.receipt is not null then routed.canonical_digest else definition.canonical_digest end as execution_digest,
    case when admission.routing_decision->>'taskClassId' is not null then
        admission.routing_decision->>'taskClassSlug'
      when admission.routing_decision is null then original_stage.slug end as task_class_slug,
    coalesce(admission.selected_stage_ids[1], manifest.stage_id, run.stage_id, owner.id) as unclassified_scope_id
  into identity
  from public.agent_runs run
  join public.sessions owner on (owner.id, owner.workspace_id, owner.factory_id, owner.execution_purpose) =
    (run.session_id, run.workspace_id, p_factory_id, 'production')
  join public.workspaces workspace on workspace.id = owner.workspace_id and workspace.deletion_requested_at is null
  left join public.session_attempt_manifests manifest
    on (manifest.run_id, manifest.workspace_id, manifest.session_id, manifest.attempt_count) =
       (run.id, run.workspace_id, run.session_id, p_run_attempt_count)
  left join public.factory_definition_revisions definition
    on (definition.workspace_id, definition.factory_id, definition.id) =
       (owner.workspace_id, owner.factory_id, owner.factory_definition_revision_id)
    and owner.execute_pinned_definition
  left join public.session_factory_admission_inputs admission
    on (admission.session_id, admission.workspace_id, admission.factory_id) = (owner.id, owner.workspace_id, owner.factory_id)
  left join lateral (
    select internal.effective_factory_routing_execution(owner.workspace_id, owner.factory_id, owner.id) as receipt
  ) routing on manifest.routing_decision_session_id is not null
  left join public.factory_definition_revisions routed
    on (routed.workspace_id, routed.factory_id, routed.id::text, routed.canonical_digest) =
       (owner.workspace_id, owner.factory_id, routing.receipt#>>'{configuration,definitionRevisionId}',
        routing.receipt->>'definitionDigest')
  left join lateral (
    select stage.value->>'slug' as slug
    from jsonb_array_elements(definition.definition_json::jsonb->'stages') stage(value)
    where stage.value->>'id' = admission.selected_stage_ids[1]::text
  ) original_stage on admission.routing_decision is null
  where (run.workspace_id, run.session_id, run.id) = (p_workspace_id, p_session_id, p_run_id)
    and (manifest.run_id is not null or run.attempt_count = p_run_attempt_count)
    and not exists (select 1 from public.session_retained_content_erasures erasure where erasure.session_id = owner.id);
  if not found then return; end if;

  if identity.task_class_slug is not null then identity.unclassified_scope_id := null; end if;
  insert into internal.factory_failure_cohorts (workspace_id, factory_id, task_class_slug, unclassified_scope_id,
    agent_id, symptom_kind, symptom_key)
  values (p_workspace_id, p_factory_id, identity.task_class_slug, identity.unclassified_scope_id,
    identity.agent_id, p_source_kind, p_symptom_key)
  on conflict (workspace_id, factory_id, task_class_slug, unclassified_scope_id, agent_id, symptom_kind, symptom_key)
  do nothing returning id into matched_cohort_id;

  if matched_cohort_id is null then
    select cohort.id into strict matched_cohort_id from internal.factory_failure_cohorts cohort
    where (cohort.workspace_id, cohort.factory_id, cohort.agent_id, cohort.symptom_kind, cohort.symptom_key) =
      (p_workspace_id, p_factory_id, identity.agent_id, p_source_kind, p_symptom_key)
      and cohort.task_class_slug is not distinct from identity.task_class_slug
      and cohort.unclassified_scope_id is not distinct from identity.unclassified_scope_id;
  end if;

  insert into internal.factory_failure_cohort_members (
    cohort_id, workspace_id, factory_id, session_id, run_id, run_attempt_count,
    definition_revision_id, definition_digest, execution_revision_id, execution_digest,
    agent_prompt_revision_id, model_provider, model_name, source_kind, evaluation_attempt_id, evaluation_job_id,
    scorer_revision_id, validation_run_id, validation_record_key, target_commit_sha, target_tree_sha, observed_at
  ) values (
    matched_cohort_id, p_workspace_id, p_factory_id, p_session_id, p_run_id, p_run_attempt_count,
    identity.definition_revision_id, identity.definition_digest, identity.execution_revision_id, identity.execution_digest,
    identity.agent_prompt_revision_id, identity.model_provider, identity.model_name, p_source_kind,
    p_evaluation_attempt_id, p_evaluation_job_id, p_scorer_revision_id,
    case when p_source_kind = 'validation' then p_run_id end, p_validation_record_key,
    p_target_commit_sha, p_target_tree_sha, p_observed_at
  ) on conflict (run_id, evaluation_attempt_id, validation_record_key) do nothing;
end;
$$;

create function internal.record_factory_scorer_failure(p_receipt public.factory_evaluation_receipts)
returns void language sql set search_path = '' as $$
  select internal.record_factory_failure_cohort_member(
    p_receipt.workspace_id, p_receipt.factory_id, p_receipt.session_id, p_receipt.run_id, sample.attempt_count,
    'scorer', revision.scorer_id::text, p_receipt.finished_at, p_receipt.target_commit_sha,
    p_receipt.attempt_id, p_receipt.job_id, p_receipt.scorer_revision_id
  )
  from public.factory_scorer_revisions revision
  join public.factory_scorer_sample_receipts sample
    on (sample.workspace_id, sample.factory_id, sample.scorer_revision_id, sample.id) =
       (revision.workspace_id, revision.factory_id, revision.id, p_receipt.sample_receipt_id)
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (p_receipt.workspace_id, p_receipt.factory_id, p_receipt.scorer_revision_id)
    and (sample.session_id, sample.run_id, sample.target_commit_sha, sample.outcome) =
      (p_receipt.session_id, p_receipt.run_id, p_receipt.target_commit_sha, 'sampled')
    and p_receipt.status = 'fail' and p_receipt.attempt_outcome = 'succeeded'
    and p_receipt.result->>'status' = 'fail';
$$;

create function internal.record_factory_validation_failures(p_receipt public.session_validation_evidence)
returns void language plpgsql set search_path = '' as $$
declare
  factory_id uuid;
  item jsonb;
begin
  select owner.factory_id into factory_id from public.sessions owner
  where (owner.id, owner.workspace_id, owner.execution_purpose) = (p_receipt.session_id, p_receipt.workspace_id, 'production');
  if not found then return; end if;

  for item in
    select record.value from jsonb_array_elements(p_receipt.records) record(value)
    where record.value->>'provenance' = 'harness' and record.value->>'status' = 'failed'
      and record.value->>'commitSha' = p_receipt.commit_sha and record.value->>'finalCommitSha' = p_receipt.commit_sha
      and record.value->>'treeSha' = p_receipt.validation_tree_sha
      and record.value->>'finalTreeSha' = p_receipt.validation_tree_sha
      and nullif(btrim(record.value->>'key'), '') is not null
      and pg_input_is_valid(record.value->>'completedAt', 'timestamp with time zone')
      and (
        (jsonb_typeof(record.value->'exitCode') = 'number' and record.value->'exitCode' <> '0'::jsonb)
        or (jsonb_typeof(record.value->'missingRequiredReports') = 'array'
          and record.value->'missingRequiredReports' <> '[]'::jsonb)
      )
    order by record.value->>'key' collate "C"
  loop
    perform internal.record_factory_failure_cohort_member(
      p_receipt.workspace_id, factory_id, p_receipt.session_id, p_receipt.run_id, p_receipt.attempt_count,
      'validation', encode(sha256(convert_to(item->>'key', 'UTF8')), 'hex'), (item->>'completedAt')::timestamptz,
      p_receipt.commit_sha, p_validation_record_key => item->>'key', p_target_tree_sha => p_receipt.validation_tree_sha
    );
  end loop;
end;
$$;

create function internal.capture_factory_scorer_failure()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into internal.factory_failure_cohort_inbox (source_kind, source_id)
  values ('scorer', new.attempt_id) on conflict (source_kind, source_id) do nothing;
  return new;
end;
$$;
create trigger capture_factory_scorer_failure after insert on public.factory_evaluation_receipts
  for each row when (new.status = 'fail' and new.attempt_outcome = 'succeeded')
  execute function internal.capture_factory_scorer_failure();

create function internal.capture_factory_validation_failures()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from jsonb_array_elements(new.records) item(value)
    where item.value->>'status' = 'failed'
  ) then
    insert into internal.factory_failure_cohort_inbox (source_kind, source_id)
    values ('validation', new.run_id) on conflict (source_kind, source_id) do nothing;
  end if;
  return new;
end;
$$;
create trigger capture_factory_validation_failures after insert on public.session_validation_evidence
  for each row execute function internal.capture_factory_validation_failures();

-- Source transactions enqueue only their own immutable identity. The single
-- projection writer can replay both captured and pre-migration receipts.
create function internal.process_factory_failure_cohorts(p_batch_size integer)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  checkpoint internal.factory_failure_cohort_backfill;
  pending internal.factory_failure_cohort_inbox;
  score public.factory_evaluation_receipts;
  validation public.session_validation_evidence;
  scanned integer;
  total_scanned integer := 0;
  batch_end_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_batch_size is null or p_batch_size not between 1 and 500 then
    raise exception 'Invalid failure cohort backfill batch size.' using errcode = '22023';
  end if;

  perform 1 from internal.factory_failure_cohort_backfill where source_kind = 'scorer' for update skip locked;
  if not found then return 0; end if;

  for pending in
    select * from internal.factory_failure_cohort_inbox order by sequence limit p_batch_size
  loop
    if pending.source_kind = 'scorer' then
      select * into score from public.factory_evaluation_receipts receipt where receipt.attempt_id = pending.source_id;
      if found then perform internal.record_factory_scorer_failure(score); end if;
    else
      select * into validation from public.session_validation_evidence receipt where receipt.run_id = pending.source_id;
      if found then perform internal.record_factory_validation_failures(validation); end if;
    end if;
    delete from internal.factory_failure_cohort_inbox where sequence = pending.sequence;
    total_scanned := total_scanned + 1;
  end loop;

  for checkpoint in
    select * from internal.factory_failure_cohort_backfill where not completed order by source_kind
  loop
    scanned := 0;
    batch_end_id := checkpoint.last_source_id;
    if checkpoint.source_kind = 'scorer' then
      for score in select * from public.factory_evaluation_receipts receipt
        where receipt.attempt_id > coalesce(checkpoint.last_source_id, '00000000-0000-0000-0000-000000000000'::uuid)
        order by receipt.attempt_id limit p_batch_size
      loop
        perform internal.record_factory_scorer_failure(score);
        batch_end_id := score.attempt_id;
        scanned := scanned + 1;
      end loop;
    else
      for validation in select * from public.session_validation_evidence receipt
        where receipt.run_id > coalesce(checkpoint.last_source_id, '00000000-0000-0000-0000-000000000000'::uuid)
        order by receipt.run_id limit p_batch_size
      loop
        perform internal.record_factory_validation_failures(validation);
        batch_end_id := validation.run_id;
        scanned := scanned + 1;
      end loop;
    end if;
    update internal.factory_failure_cohort_backfill
    set last_source_id = batch_end_id, completed = scanned < p_batch_size
    where source_kind = checkpoint.source_kind;
    total_scanned := total_scanned + scanned;
  end loop;
  return total_scanned;
end;
$$;

create function public.process_factory_failure_cohorts(p_batch_size integer default 100)
returns integer language sql security invoker set search_path = '' as $$
  select internal.process_factory_failure_cohorts(p_batch_size);
$$;

create function internal.visible_factory_failure_cohort_members(p_cohort internal.factory_failure_cohorts)
returns setof internal.factory_failure_cohort_members language sql stable set search_path = '' as $$
  select member.*
  from internal.factory_failure_cohort_members member
  where (member.workspace_id, member.factory_id, member.cohort_id, member.source_kind) =
    (p_cohort.workspace_id, p_cohort.factory_id, p_cohort.id, p_cohort.symptom_kind)
    and not exists (
      select 1 from public.session_retained_content_erasures erasure
      where (erasure.workspace_id, erasure.factory_id, erasure.session_id) =
        (member.workspace_id, member.factory_id, member.session_id)
    )
$$;

create function internal.factory_failure_member_evidence_state(p_member internal.factory_failure_cohort_members)
returns text language plpgsql stable set search_path = '' as $$
declare
  score public.factory_evaluation_receipts;
  validation public.session_validation_evidence;
  observed_record jsonb;
begin
  if p_member.source_kind = 'scorer' then
    select * into score from public.factory_evaluation_receipts receipt
    where (receipt.attempt_id, receipt.workspace_id, receipt.factory_id, receipt.session_id,
           receipt.run_id, receipt.job_id, receipt.scorer_revision_id, receipt.target_commit_sha) =
      (p_member.evaluation_attempt_id, p_member.workspace_id, p_member.factory_id, p_member.session_id,
       p_member.run_id, p_member.evaluation_job_id, p_member.scorer_revision_id, p_member.target_commit_sha);
    if not found then return 'unavailable'; end if;
    return internal.factory_evaluation_receipt_evidence_availability(score);
  end if;

  select * into validation from public.session_validation_evidence receipt
  where (receipt.run_id, receipt.workspace_id, receipt.session_id, receipt.attempt_count,
         receipt.commit_sha, receipt.validation_tree_sha) =
    (p_member.validation_run_id, p_member.workspace_id, p_member.session_id, p_member.run_attempt_count,
     p_member.target_commit_sha, p_member.target_tree_sha);
  if not found then return 'unavailable'; end if;
  select item.value into observed_record
  from jsonb_array_elements(validation.records) item(value)
  where item.value->>'key' = p_member.validation_record_key;
  if not found then return 'unavailable'; end if;

  if exists (
    select 1 from public.session_validation_assets asset
    join public.session_validation_asset_withholdings withholding on withholding.asset_id = asset.id
    where (asset.workspace_id, asset.session_id, asset.run_id) =
      (p_member.workspace_id, p_member.session_id, p_member.run_id)
      and (
        asset.evidence_key = p_member.validation_record_key || '/log'
        or (observed_record->'reportKeys') ? asset.evidence_key
      )
  ) then return 'withheld'; end if;

  if exists (
    select 1 from jsonb_array_elements_text(
      case when jsonb_typeof(observed_record->'reportKeys') = 'array' then observed_record->'reportKeys' else '[]'::jsonb end
    ) required(evidence_key)
    where not exists (
      select 1 from public.session_validation_assets asset
      join storage.objects object on object.bucket_id = 'session-validation-evidence' and object.name = asset.storage_path
      where (asset.workspace_id, asset.session_id, asset.run_id, asset.evidence_key) =
        (p_member.workspace_id, p_member.session_id, p_member.run_id, required.evidence_key)
        and object.metadata->>'size' = asset.size_bytes::text and object.metadata->>'mimetype' = asset.content_type
    )
  ) then return 'unavailable'; end if;
  return 'available';
end;
$$;

create function internal.summarize_factory_failure_cohort(p_cohort internal.factory_failure_cohorts)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  support record;
  label text;
  qualification_reasons text[] := '{}';
begin
  with visible as materialized (
    select member.*, internal.factory_failure_member_evidence_state(member) as evidence_state
    from internal.visible_factory_failure_cohort_members(p_cohort) member
  )
  select count(distinct run_id) as failure_count, count(distinct session_id) as support_count,
    count(distinct (definition_revision_id, execution_revision_id, agent_prompt_revision_id,
      model_provider, model_name, scorer_revision_id)) as version_count,
    bool_or(evidence_state <> 'available') as missing_evidence,
    bool_or(definition_revision_id is null or execution_revision_id is null) as missing_identity,
    min(validation_record_key) filter (where evidence_state = 'available') as available_validation_label
  into support from visible;
  if support.failure_count = 0 then return null; end if;

  if support.support_count < p_cohort.minimum_support then
    qualification_reasons := array_append(qualification_reasons, 'insufficient_support');
  end if;
  if support.version_count > 1 then
    qualification_reasons := array_append(qualification_reasons, 'mixed_versions');
  end if;
  if support.missing_evidence then
    qualification_reasons := array_append(qualification_reasons, 'missing_evidence');
  end if;
  if support.missing_identity or p_cohort.task_class_slug is null then
    qualification_reasons := array_append(qualification_reasons, 'missing_identity');
  end if;

  if p_cohort.symptom_kind = 'scorer' then
    select scorer.name into label from public.factory_scorers scorer
    where (scorer.workspace_id, scorer.factory_id, scorer.id::text) =
      (p_cohort.workspace_id, p_cohort.factory_id, p_cohort.symptom_key);
  else
    label := support.available_validation_label;
  end if;

  return jsonb_build_object(
    'id', p_cohort.id, 'task_class_slug', p_cohort.task_class_slug, 'agent_id', p_cohort.agent_id,
    'symptom_kind', p_cohort.symptom_kind, 'symptom_label', label,
    'failure_count', support.failure_count, 'support_count', support.support_count,
    'minimum_support', p_cohort.minimum_support, 'version_count', support.version_count,
    'qualification', case when cardinality(qualification_reasons) = 0 then 'qualified' else 'inconclusive' end,
    'qualification_reasons', qualification_reasons
  );
end;
$$;

create function internal.project_factory_failure_cohort_member(
  p_agent_id uuid, p_member internal.factory_failure_cohort_members
) returns jsonb language sql stable set search_path = '' as $$
  with evidence as materialized (
    select internal.factory_failure_member_evidence_state(p_member) as state
  )
  select jsonb_build_object(
    'id', p_member.id, 'session_id', p_member.session_id, 'run_id', p_member.run_id,
    'run_attempt_count', p_member.run_attempt_count, 'observed_at', p_member.observed_at,
    'configuration', jsonb_build_object(
      'definition_revision_id', p_member.definition_revision_id, 'definition_digest', p_member.definition_digest,
      'execution_revision_id', p_member.execution_revision_id, 'execution_digest', p_member.execution_digest,
      'agent_id', p_agent_id, 'agent_prompt_revision_id', p_member.agent_prompt_revision_id,
      'model_provider', p_member.model_provider, 'model_name', p_member.model_name
    ),
    'source', jsonb_build_object(
      'kind', p_member.source_kind, 'evaluation_job_id', p_member.evaluation_job_id,
      'evaluation_attempt_id', p_member.evaluation_attempt_id, 'scorer_revision_id', p_member.scorer_revision_id,
      'validation_run_id', p_member.validation_run_id,
      'validation_record_key', case when evidence.state = 'available' then p_member.validation_record_key end,
      'target_commit_sha', case when evidence.state = 'available' then p_member.target_commit_sha end,
      'target_tree_sha', case when evidence.state = 'available' then p_member.target_tree_sha end,
      'evidence_state', evidence.state
    )
  )
  from evidence
$$;

create function internal.assert_factory_failure_cohort_read(p_workspace_id uuid, p_factory_id uuid, p_limit integer)
returns void language plpgsql stable set search_path = '' as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.factories factory where (factory.workspace_id, factory.id) = (p_workspace_id, p_factory_id)
      and internal.can_access_factory(factory.workspace_id, factory.id)
  ) then
    raise exception 'Failure cohort factory is unavailable.' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid failure cohort page size.' using errcode = '22023';
  end if;
end;
$$;

create function internal.list_factory_failure_cohorts(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer, p_after_cohort_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  with page as materialized (
    select cohort.id, cohort as item from internal.factory_failure_cohorts cohort
    where (cohort.workspace_id, cohort.factory_id) = (p_workspace_id, p_factory_id)
      and (p_after_cohort_id is null or cohort.id > p_after_cohort_id)
      and exists (select 1 from internal.visible_factory_failure_cohort_members(cohort))
    order by cohort.id limit p_limit + 1
  ),
  visible as (
    select * from page order by id limit p_limit
  )
  select jsonb_build_object(
    'cohorts', coalesce(jsonb_agg(internal.summarize_factory_failure_cohort(item) order by id), '[]'),
    'next_cohort_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

create function internal.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer, p_after_member_id uuid
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  cohort internal.factory_failure_cohorts;
  summary jsonb;
  result jsonb;
begin
  perform internal.assert_factory_failure_cohort_read(p_workspace_id, p_factory_id, p_limit);
  select * into cohort from internal.factory_failure_cohorts candidate
  where (candidate.workspace_id, candidate.factory_id, candidate.id) = (p_workspace_id, p_factory_id, p_cohort_id);
  if found then summary := internal.summarize_factory_failure_cohort(cohort); end if;
  if summary is null then raise exception 'Failure cohort is unavailable.' using errcode = 'P0002'; end if;

  with page as materialized (
    select member.id, member as item from internal.visible_factory_failure_cohort_members(cohort) member
    where p_after_member_id is null or member.id > p_after_member_id
    order by member.id limit p_limit + 1
  ),
  visible as (
    select * from page order by id limit p_limit
  )
  select jsonb_build_object(
    'cohort', summary,
    'members', coalesce(jsonb_agg(internal.project_factory_failure_cohort_member(cohort.agent_id, item) order by id), '[]'),
    'next_member_id', case when (select count(*) from page) > p_limit then
      (select id from visible order by id desc limit 1) end
  ) into result from visible;
  return result;
end;
$$;

create function public.list_factory_failure_cohorts(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer default 25, p_after_cohort_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.list_factory_failure_cohorts(p_workspace_id, p_factory_id, p_limit, p_after_cohort_id)
$$;

create function public.get_factory_failure_cohort(
  p_workspace_id uuid, p_factory_id uuid, p_cohort_id uuid, p_limit integer default 25, p_after_member_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.get_factory_failure_cohort(p_workspace_id, p_factory_id, p_cohort_id, p_limit, p_after_member_id)
$$;

revoke all on function internal.guard_factory_failure_cohort(),
  internal.guard_factory_failure_cohort_member(),
  internal.record_factory_failure_cohort_member(uuid, uuid, uuid, uuid, integer, text, text, timestamptz, text,
    uuid, uuid, uuid, text, text),
  internal.record_factory_scorer_failure(public.factory_evaluation_receipts),
  internal.record_factory_validation_failures(public.session_validation_evidence),
  internal.capture_factory_scorer_failure(), internal.capture_factory_validation_failures(),
  internal.process_factory_failure_cohorts(integer), public.process_factory_failure_cohorts(integer),
  internal.visible_factory_failure_cohort_members(internal.factory_failure_cohorts),
  internal.factory_failure_member_evidence_state(internal.factory_failure_cohort_members),
  internal.summarize_factory_failure_cohort(internal.factory_failure_cohorts),
  internal.project_factory_failure_cohort_member(uuid, internal.factory_failure_cohort_members),
  internal.assert_factory_failure_cohort_read(uuid, uuid, integer),
  internal.list_factory_failure_cohorts(uuid, uuid, integer, uuid),
  internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid),
  public.list_factory_failure_cohorts(uuid, uuid, integer, uuid),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid)
  from public, anon, authenticated, service_role;
grant execute on function internal.process_factory_failure_cohorts(integer),
  public.process_factory_failure_cohorts(integer) to service_role;
grant execute on function internal.list_factory_failure_cohorts(uuid, uuid, integer, uuid),
  internal.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid),
  public.list_factory_failure_cohorts(uuid, uuid, integer, uuid),
  public.get_factory_failure_cohort(uuid, uuid, uuid, integer, uuid) to authenticated;
