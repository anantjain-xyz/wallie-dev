-- Repository-specific graph authority and parent-owned delivery.
create table internal.factory_workflow_repository_writers (
  graph_revision_id uuid not null references internal.factory_workflow_graph_revisions(id) on delete cascade,
  join_node_id text not null,
  repository_id uuid not null,
  branch_edge_ids text[] not null check (cardinality(branch_edge_ids) between 1 and 128),
  grant_id uuid not null,
  grant_version bigint not null check (grant_version between 1 and 9007199254740991),
  primary key (graph_revision_id, join_node_id, repository_id),
  unique (graph_revision_id, join_node_id, grant_id)
);

-- Secondary cursors only. The primary uses OP652's existing session Git head.
create table internal.factory_workflow_secondary_repository_heads (
  root_session_id uuid not null references internal.factory_workflow_executions(root_session_id) on delete cascade,
  parent_session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  repository_id uuid not null,
  receipt_id uuid not null unique default gen_random_uuid(),
  base_branch text not null,
  initial_base_sha text not null check (initial_base_sha collate "C" ~ '^[a-f0-9]{40}$'),
  accepted_sha text not null check (accepted_sha collate "C" ~ '^[a-f0-9]{40}$'),
  fetch_ref text,
  primary key (root_session_id, parent_session_id, repository_id),
  foreign key (parent_session_id, workspace_id, factory_id)
    references public.sessions(id, workspace_id, factory_id) on delete cascade
);

create table internal.factory_workflow_repository_delivery_targets (
  root_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  parent_session_id uuid not null,
  workspace_id uuid not null,
  factory_id uuid not null,
  grant_id uuid not null,
  grant_version bigint not null,
  installation_id uuid not null,
  installation_numeric_id bigint not null,
  repository_numeric_id bigint not null,
  repository_full_name text not null,
  expected_head_receipt_id uuid not null,
  base_sha text not null,
  base_branch text not null,
  base_fetch_ref text,
  deadline_at timestamptz not null check (isfinite(deadline_at)),
  primary key (root_session_id, join_id, repository_id),
  foreign key (root_session_id, join_id)
    references internal.factory_workflow_joins(root_session_id, join_id) on delete cascade
);

-- Trusted integration dispatch creates this causal binding before validation.
-- One attempt carries one repository. Appending cannot import a branch's proof.
create table internal.factory_workflow_repository_validation_attempts (
  root_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  validation_session_id uuid not null,
  validation_job_id uuid not null unique,
  validation_run_id uuid not null unique,
  attempt_count integer not null check (attempt_count > 0),
  generation bigint not null,
  deadline_at timestamptz not null,
  primary key (root_session_id, join_id, repository_id, validation_run_id),
  foreign key (root_session_id, join_id, repository_id)
    references internal.factory_workflow_repository_delivery_targets(root_session_id, join_id, repository_id)
    on delete cascade
);

create table internal.factory_workflow_repository_delivery_intents (
  root_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  validation_run_id uuid not null,
  candidate_sha text not null check (candidate_sha collate "C" ~ '^[a-f0-9]{40}$'),
  tree_sha text not null check (tree_sha collate "C" ~ '^[a-f0-9]{40}$'),
  bundle_sha256 text check (bundle_sha256 collate "C" ~ '^[a-f0-9]{64}$'),
  retained_ref text,
  bundle_bytes bytea,
  primary key (root_session_id, join_id, repository_id),
  foreign key (root_session_id, join_id, repository_id, validation_run_id)
    references internal.factory_workflow_repository_validation_attempts(root_session_id, join_id, repository_id, validation_run_id)
    on delete cascade,
  check ((bundle_sha256 is null) = (retained_ref is null) and (bundle_sha256 is null) = (bundle_bytes is null)),
  check (bundle_bytes is null or (octet_length(bundle_bytes) between 1 and 4194304
    and encode(sha256(bundle_bytes), 'hex') = bundle_sha256))
);

create table internal.factory_workflow_repository_delivery_state (
  root_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  status text not null default 'awaiting_validation' check (status in ('awaiting_validation','pending','claimed','blocked','adopted')),
  blocker text check (blocker in ('publication_unavailable','authority_unavailable','stale_repository_head',
    'validation_unavailable','validation_failed','merge_conflict','join_unavailable','incompatible_ref','deadline_expired')),
  claim_id uuid,
  claim_generation bigint,
  claim_until timestamptz,
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default clock_timestamp(),
  prospective_remote_ref boolean not null default false,
  observed_conflicting_sha text check (observed_conflicting_sha collate "C" ~ '^[a-f0-9]{40}$'),
  adopted_claim_id uuid,
  accepted_head_receipt_id uuid,
  verified_ref text,
  verified_sha text,
  adopted_at timestamptz,
  primary key (root_session_id, join_id, repository_id),
  foreign key (root_session_id, join_id, repository_id)
    references internal.factory_workflow_repository_delivery_targets(root_session_id, join_id, repository_id) on delete cascade,
  check ((status = 'claimed') = (claim_id is not null)),
  check ((claim_id is null) = (claim_generation is null) and (claim_id is null) = (claim_until is null)),
  check ((status = 'adopted') = (adopted_claim_id is not null and accepted_head_receipt_id is not null and adopted_at is not null)),
  check ((verified_ref is null) = (verified_sha is null))
);

alter table internal.factory_workflow_repository_writers enable row level security;
alter table internal.factory_workflow_secondary_repository_heads enable row level security;
alter table internal.factory_workflow_repository_delivery_targets enable row level security;
alter table internal.factory_workflow_repository_validation_attempts enable row level security;
alter table internal.factory_workflow_repository_delivery_intents enable row level security;
alter table internal.factory_workflow_repository_delivery_state enable row level security;
revoke all on table internal.factory_workflow_repository_writers, internal.factory_workflow_secondary_repository_heads,
  internal.factory_workflow_repository_delivery_targets, internal.factory_workflow_repository_validation_attempts,
  internal.factory_workflow_repository_delivery_intents, internal.factory_workflow_repository_delivery_state
from public, anon, authenticated, service_role;

create trigger freeze_factory_workflow_repository_writer before update on internal.factory_workflow_repository_writers
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_repository_target before update on internal.factory_workflow_repository_delivery_targets
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_repository_validation_attempt before update on internal.factory_workflow_repository_validation_attempts
  for each row execute function internal.reject_factory_workflow_join_update();
create trigger freeze_factory_workflow_repository_intent before update on internal.factory_workflow_repository_delivery_intents
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.resolve_factory_workflow_repository_writer(
  p_execution internal.factory_workflow_executions,
  p_manifest internal.factory_workflow_joins,
  p_repository_id uuid
) returns internal.factory_workflow_repository_writers
language plpgsql set search_path='' as $$
declare
  writer internal.factory_workflow_repository_writers;
  approved public.factory_execution_grants;
  pin public.session_factory_admission_inputs;
begin
  select declared.* into writer from internal.factory_workflow_repository_writers declared
  join internal.factory_workflow_node_occurrences occurrence
    on (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_id) =
      (p_manifest.root_session_id, p_manifest.join_occurrence_id, declared.join_node_id)
  where (declared.graph_revision_id, declared.repository_id) = (p_execution.graph_revision_id, p_repository_id);
  if not found or p_repository_id = p_manifest.repository_id then return null; end if;
  select admitted.* into pin from public.session_factory_admission_inputs admitted
  where (admitted.session_id, admitted.workspace_id, admitted.factory_id) =
    (p_manifest.parent_session_id, p_manifest.workspace_id, p_manifest.factory_id);
  if not found or pin.execution_grant_id is null
    or not internal.recheck_factory_workflow_delegation_lineage(
      p_manifest.root_session_id, p_manifest.workspace_id, p_manifest.factory_id, p_manifest.parent_session_id
    ) then return null; end if;
  approved := internal.require_current_factory_execution_grant(
    p_manifest.workspace_id, p_manifest.factory_id, writer.grant_id, writer.grant_version,
    p_repository_id, '{}'::uuid[], '{}'::text[], pin.execution_policy_revision_id);
  if (approved.service_principal_id, approved.budget_payer_member_id) is distinct from
    (pin.credential_owner_service_principal_id, pin.budget_payer_member_id) then return null; end if;
  return writer;
exception when insufficient_privilege then
  return null;
end;
$$;

create function internal.read_factory_workflow_repository_installation(
  p_workspace_id uuid, p_factory_id uuid, p_repository_id uuid
) returns table(installation_id uuid, installation_numeric_id bigint, repository_numeric_id bigint, repository_full_name text)
language sql set search_path='' as $$
  select installation.id, installation.installation_id, repository.repo_id, repository.full_name
  from public.github_repositories repository
  join public.github_installations installation
    on (installation.id, installation.workspace_id) = (repository.github_installation_id, repository.workspace_id)
  where (repository.id, repository.workspace_id, repository.factory_id) = (p_repository_id, p_workspace_id, p_factory_id)
    and not repository.is_archived and not installation.suspended
    and installation.permissions->>'contents' in ('write','admin')
  for share of installation, repository nowait
$$;

create function internal.factory_workflow_repository_validation_passes(
  p_target internal.factory_workflow_repository_delivery_targets,
  p_validation_run_id uuid, p_candidate_sha text, p_tree_sha text,
  p_required_evidence jsonb
) returns boolean language plpgsql set search_path='' as $$
declare
  plan public.session_validation_plans;
  requirement text;
begin
  select stored.* into plan
  from internal.factory_workflow_repository_validation_attempts bound
  join public.session_validation_plans stored on
    (stored.workspace_id,stored.session_id,stored.job_id,stored.run_id,stored.attempt_count,stored.repository_id) =
    (p_target.workspace_id,bound.validation_session_id,bound.validation_job_id,bound.validation_run_id,bound.attempt_count,bound.repository_id)
  join public.sessions subject on
    (subject.id,subject.workspace_id,subject.factory_id) = (bound.validation_session_id,p_target.workspace_id,p_target.factory_id)
  join public.session_job_git_inputs input on
    (input.job_id,input.workspace_id,input.session_id,input.repository_id,input.pinned_run_id,input.pinned_attempt_count,input.input_sha) =
    (bound.validation_job_id,p_target.workspace_id,bound.validation_session_id,p_target.repository_id,bound.validation_run_id,bound.attempt_count,p_target.base_sha)
  where (bound.root_session_id,bound.join_id,bound.repository_id,bound.validation_run_id) =
    (p_target.root_session_id,p_target.join_id,p_target.repository_id,p_validation_run_id)
    and (stored.commit_sha,stored.validation_tree_sha) = (p_candidate_sha,p_tree_sha);
  if not found or jsonb_typeof(p_required_evidence) is distinct from 'array' or jsonb_array_length(p_required_evidence) = 0
    then return false; end if;
  for requirement in select jsonb_array_elements_text(p_required_evidence) loop
    if requirement collate "C" ~ '^browser:(screenshot|video):[A-Za-z0-9][A-Za-z0-9._-]{0,99}$' then
      if not internal.factory_workflow_browser_evidence_passes(plan,requirement) then return false; end if;
    elsif not internal.factory_workflow_command_evidence_passes(plan,requirement) then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

create function internal.seal_factory_workflow_repository_delivery(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid, p_validation_run_id uuid, p_candidate_sha text, p_tree_sha text, p_bundle_sha256 text,
  p_bundle_base64 text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  target internal.factory_workflow_repository_delivery_targets;
  prior internal.factory_workflow_repository_delivery_intents;
  writer internal.factory_workflow_repository_writers;
  validation_deadline timestamptz;
  ref text;
  bundle bytea;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,p_generation,p_owner);
  if execution.lifecycle_status <> 'running' then return false; end if;
  select * into manifest from internal.factory_workflow_joins
  where (root_session_id,join_id,workspace_id,factory_id) = (p_root_session_id,p_join_id,p_workspace_id,p_factory_id);
  if not found then return false; end if;
  select * into target from internal.factory_workflow_repository_delivery_targets
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if not found then return false; end if;
  if (p_bundle_base64 is null) is distinct from (p_bundle_sha256 is null)
    or coalesce(octet_length(p_bundle_base64),0) > 5592408 then return false; end if;
  if p_bundle_sha256 is not null then
    bundle := decode(p_bundle_base64,'base64');
    if octet_length(bundle) not between 1 and 4194304 or encode(sha256(bundle),'hex')<>p_bundle_sha256 then return false; end if;
  end if;
  select * into prior from internal.factory_workflow_repository_delivery_intents
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if found then
    if (prior.validation_run_id,prior.candidate_sha,prior.tree_sha,prior.bundle_sha256)
      is distinct from (p_validation_run_id,p_candidate_sha,p_tree_sha,p_bundle_sha256)
      then raise exception 'The repository delivery intent already owns a different output.' using errcode='PT409'; end if;
    return true;
  end if;
  writer := internal.resolve_factory_workflow_repository_writer(execution,manifest,p_repository_id);
  if (writer.grant_id,writer.grant_version) is distinct from (target.grant_id,target.grant_version)
    or target.deadline_at <= clock_timestamp()
    or p_candidate_sha is null or p_candidate_sha collate "C" !~ '^[a-f0-9]{40}$'
    or p_tree_sha is null or p_tree_sha collate "C" !~ '^[a-f0-9]{40}$'
    or (p_candidate_sha = target.base_sha) is distinct from (p_bundle_sha256 is null)
    or (p_bundle_sha256 is not null and p_bundle_sha256 collate "C" !~ '^[a-f0-9]{64}$')
    or not internal.factory_workflow_repository_validation_passes(target,p_validation_run_id,p_candidate_sha,p_tree_sha,manifest.required_evidence)
    then return false; end if;
  select bound.deadline_at into strict validation_deadline
  from internal.factory_workflow_repository_validation_attempts bound
  where (bound.root_session_id,bound.join_id,bound.repository_id,bound.validation_run_id) =
    (p_root_session_id,p_join_id,p_repository_id,p_validation_run_id);
  if clock_timestamp() >= least(target.deadline_at, validation_deadline) then return false; end if;
  if p_bundle_sha256 is not null then ref := 'refs/heads/wallie/checkpoints/' || p_validation_run_id || '/' || p_candidate_sha; end if;
  insert into internal.factory_workflow_repository_delivery_intents(root_session_id,join_id,repository_id,
    validation_run_id,candidate_sha,tree_sha,bundle_sha256,retained_ref,bundle_bytes)
  values (p_root_session_id,p_join_id,p_repository_id,p_validation_run_id,p_candidate_sha,p_tree_sha,p_bundle_sha256,ref,bundle);
  update internal.factory_workflow_repository_delivery_state set status='pending',next_attempt_at=clock_timestamp()
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  return true;
end;
$$;

create function public.claim_factory_workflow_repository_delivery(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  target internal.factory_workflow_repository_delivery_targets;
  intent internal.factory_workflow_repository_delivery_intents;
  progress internal.factory_workflow_repository_delivery_state;
  blocker text;
  validation internal.factory_workflow_repository_validation_attempts;
begin
  perform internal.assert_checkpoint_publication_service();
  execution := internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,p_generation,p_owner);
  if execution.lifecycle_status <> 'running' then return null; end if;
  select * into manifest from internal.factory_workflow_joins
  where (root_session_id,join_id,workspace_id,factory_id) = (p_root_session_id,p_join_id,p_workspace_id,p_factory_id);
  if not found then return null; end if;
  select * into target from internal.factory_workflow_repository_delivery_targets
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if not found then return null; end if;
  select * into progress from internal.factory_workflow_repository_delivery_state
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if progress.status not in ('claimed','pending') or progress.next_attempt_at > clock_timestamp()
    or (progress.status='claimed' and progress.claim_generation=execution.generation and progress.claim_until>clock_timestamp())
    then return null; end if;
  select * into intent from internal.factory_workflow_repository_delivery_intents
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  blocker := internal.factory_workflow_repository_delivery_fence(execution,manifest,target,intent);
  if blocker is not null then
    if blocker <> 'join_unavailable' then
      update internal.factory_workflow_repository_delivery_state set status='blocked',blocker=claim_factory_workflow_repository_delivery.blocker,
        claim_id=null,claim_generation=null,claim_until=null
      where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
    end if;
    return null;
  end if;
  update internal.factory_workflow_repository_delivery_state
  set status='claimed',blocker=null,claim_id=gen_random_uuid(),claim_generation=execution.generation,
    claim_until=least(clock_timestamp()+interval '2 minutes',target.deadline_at),attempts=attempts+1,
    prospective_remote_ref=prospective_remote_ref or intent.retained_ref is not null
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id)
  returning * into progress;
  select * into strict validation from internal.factory_workflow_repository_validation_attempts
  where (root_session_id,join_id,repository_id,validation_run_id) =
    (p_root_session_id,p_join_id,p_repository_id,intent.validation_run_id);
  return jsonb_build_object('target',to_jsonb(target),'intent',jsonb_build_object(
      'candidate_sha',intent.candidate_sha,'tree_sha',intent.tree_sha,
      'bundle_sha256',intent.bundle_sha256,'retained_ref',intent.retained_ref),
    'validation',to_jsonb(validation),
    'leaseId',progress.claim_id,'generation',progress.claim_generation,'expiresAt',progress.claim_until);
end;
$$;

-- One RPC serves verify-before-write, adoption, and honest transport release.
-- It never accepts a proof for a different installation, repository, ref or SHA.
create function public.settle_factory_workflow_repository_delivery(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid, p_claim_id uuid, p_action text,
  p_remote_repository_id bigint default null, p_remote_ref text default null, p_remote_sha text default null
) returns text language plpgsql security definer set search_path='' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  target internal.factory_workflow_repository_delivery_targets;
  intent internal.factory_workflow_repository_delivery_intents;
  progress internal.factory_workflow_repository_delivery_state;
  blocked_by text;
  new_head uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_action is null or p_action not in ('verify','adopt','retry','incompatible_ref') then
    raise exception 'Invalid repository publication action.' using errcode='22023';
  end if;
  execution := internal.lock_factory_workflow_owner(p_root_session_id,p_workspace_id,p_factory_id,p_generation,p_owner);
  if execution.lifecycle_status <> 'running' then return 'stale_lease'; end if;
  select * into manifest from internal.factory_workflow_joins
  where (root_session_id,join_id,workspace_id,factory_id) = (p_root_session_id,p_join_id,p_workspace_id,p_factory_id);
  if not found then return 'stale_lease'; end if;
  select * into target from internal.factory_workflow_repository_delivery_targets
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if not found then return 'stale_lease'; end if;
  select * into progress from internal.factory_workflow_repository_delivery_state
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  if progress.status='adopted' then
    if p_action='adopt' and p_claim_id=progress.adopted_claim_id
      and p_remote_repository_id=target.repository_numeric_id
      and (p_remote_ref,p_remote_sha) is not distinct from (progress.verified_ref,progress.verified_sha)
      then return 'adopted'; end if;
    return 'stale_lease';
  end if;
  if progress.status <> 'claimed' or p_claim_id is null or p_claim_id is distinct from progress.claim_id
    or progress.claim_generation <> execution.generation or progress.claim_until <= clock_timestamp() then return 'stale_lease'; end if;
  select * into intent from internal.factory_workflow_repository_delivery_intents
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  blocked_by := internal.factory_workflow_repository_delivery_fence(execution,manifest,target,intent);
  if blocked_by is not null then
    update internal.factory_workflow_repository_delivery_state
    set status='blocked',blocker=blocked_by,claim_id=null,claim_generation=null,claim_until=null
    where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
    return blocked_by;
  end if;
  if p_action='verify' then return 'current'; end if;
  if p_action='retry' then
    update internal.factory_workflow_repository_delivery_state set status='pending',blocker='publication_unavailable',
      claim_id=null,claim_generation=null,claim_until=null,next_attempt_at=clock_timestamp()+interval '5 seconds'
    where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
    return 'publication_unavailable';
  end if;
  if p_action='incompatible_ref' then
    if intent.retained_ref is null or (p_remote_repository_id,p_remote_ref) is distinct from
      (target.repository_numeric_id,intent.retained_ref) or p_remote_sha is null or p_remote_sha collate "C" !~ '^[a-f0-9]{40}$'
      or p_remote_sha=intent.candidate_sha then return 'proof_mismatch'; end if;
    update internal.factory_workflow_repository_delivery_state set status='blocked',blocker='incompatible_ref',observed_conflicting_sha=p_remote_sha,
      claim_id=null,claim_generation=null,claim_until=null
    where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
    return 'incompatible_ref';
  end if;
  if (p_remote_repository_id,p_remote_ref,p_remote_sha) is distinct from
    (target.repository_numeric_id,intent.retained_ref,case when intent.retained_ref is not null then intent.candidate_sha end)
    then return 'proof_mismatch'; end if;
  if progress.claim_until<=clock_timestamp() or target.deadline_at<=clock_timestamp() then return 'stale_lease'; end if;

  update internal.factory_workflow_secondary_repository_heads
  set receipt_id=gen_random_uuid(),accepted_sha=intent.candidate_sha,fetch_ref=coalesce(intent.retained_ref,target.base_fetch_ref)
  where (root_session_id,parent_session_id,repository_id,receipt_id) =
    (p_root_session_id,target.parent_session_id,p_repository_id,target.expected_head_receipt_id)
  returning receipt_id into new_head;
  if not found then raise exception 'Repository head adoption lost its causal receipt.' using errcode='23514'; end if;
  update internal.factory_workflow_repository_delivery_state
  set status='adopted',blocker=null,claim_id=null,claim_generation=null,claim_until=null,prospective_remote_ref=false,
    adopted_claim_id=p_claim_id,accepted_head_receipt_id=new_head,verified_ref=p_remote_ref,verified_sha=p_remote_sha,adopted_at=clock_timestamp()
  where (root_session_id,join_id,repository_id) = (p_root_session_id,p_join_id,p_repository_id);
  return 'adopted';
end;
$$;

create function public.read_factory_workflow_repository_bundle(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_generation bigint,p_owner uuid,
  p_join_id uuid,p_repository_id uuid,p_claim_id uuid
) returns text language plpgsql security definer set search_path='' as $$
begin
  if public.settle_factory_workflow_repository_delivery(p_root_session_id,p_workspace_id,p_factory_id,p_generation,p_owner,
    p_join_id,p_repository_id,p_claim_id,'verify') <> 'current' then return null; end if;
  return (select encode(intent.bundle_bytes,'base64') from internal.factory_workflow_repository_delivery_intents intent
    where (intent.root_session_id,intent.join_id,intent.repository_id) = (p_root_session_id,p_join_id,p_repository_id));
end;
$$;

create function public.read_factory_workflow_repository_delivery(
  p_root_session_id uuid,p_workspace_id uuid,p_factory_id uuid,p_join_id uuid
) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('status',case
      when terminal.outcome='adopted' and bool_and(progress.status='adopted') then 'adopted'
      when terminal.outcome='adopted' or bool_or(progress.status='adopted') then 'partial'
      when terminal.outcome in ('conflict','validation_failed') or bool_or(progress.status='blocked') then 'blocked'
      else 'pending' end,
    'primaryRepositoryId',manifest.repository_id,'primaryOutcome',terminal.outcome,
    'lifecycleStatus',execution.lifecycle_status,
    'repositories',jsonb_agg(jsonb_build_object('repositoryId',target.repository_id,'repositoryName',target.repository_full_name,
      'status',progress.status,'baseSha',target.base_sha,'outputSha',intent.candidate_sha,'validationTreeSha',intent.tree_sha,
      'validationRunId',intent.validation_run_id,
      'blocker',progress.blocker,'attempts',progress.attempts,'expectedHeadReceiptId',target.expected_head_receipt_id,
      'acceptedHeadReceiptId',progress.accepted_head_receipt_id,'remoteReconciliationRequired',progress.prospective_remote_ref)
      order by target.repository_id))
  from internal.factory_workflow_repository_delivery_targets target
  join internal.factory_workflow_repository_delivery_state progress using (root_session_id,join_id,repository_id)
  left join internal.factory_workflow_repository_delivery_intents intent using (root_session_id,join_id,repository_id)
  join internal.factory_workflow_joins manifest using (root_session_id,join_id)
  join internal.factory_workflow_executions execution on execution.root_session_id=target.root_session_id
  left join internal.factory_workflow_join_outcomes terminal
    on (terminal.root_session_id,terminal.join_id)=(target.root_session_id,target.join_id)
  where (target.root_session_id,target.workspace_id,target.factory_id,target.join_id) =
    (p_root_session_id,p_workspace_id,p_factory_id,p_join_id)
  group by manifest.repository_id,terminal.outcome,execution.lifecycle_status
$$;

revoke all on function internal.seal_factory_workflow_repository_delivery(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,text,text,text),
  internal.resolve_factory_workflow_repository_writer(internal.factory_workflow_executions,internal.factory_workflow_joins,uuid),
  internal.read_factory_workflow_repository_installation(uuid,uuid,uuid),
  internal.factory_workflow_repository_validation_passes(internal.factory_workflow_repository_delivery_targets,uuid,text,text,jsonb)
from public,anon,authenticated,service_role;
revoke all on function
  public.claim_factory_workflow_repository_delivery(uuid,uuid,uuid,bigint,uuid,uuid,uuid),
  public.settle_factory_workflow_repository_delivery(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,bigint,text,text),
  public.read_factory_workflow_repository_bundle(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.read_factory_workflow_repository_delivery(uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
grant execute on function
  public.claim_factory_workflow_repository_delivery(uuid,uuid,uuid,bigint,uuid,uuid,uuid),
  public.settle_factory_workflow_repository_delivery(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid,text,bigint,text,text),
  public.read_factory_workflow_repository_bundle(uuid,uuid,uuid,bigint,uuid,uuid,uuid,uuid),
  public.read_factory_workflow_repository_delivery(uuid,uuid,uuid,uuid)
to service_role;

-- Registration projects immutable branch authority from the exact compiled graph.
create function internal.project_factory_workflow_repository_writers()
returns trigger language plpgsql set search_path = '' as $$
declare
  plan jsonb := new.workflow_json::jsonb;
  root_definition jsonb;
  primary_repository uuid;
  group_entry record;
  specification jsonb;
  repository uuid;
  writer_id uuid;
  writer_version bigint;
  writer public.factory_execution_grants;
  eligible_edges text[];
  required_edges text[];
  assigned_edges text[];
  edge_ids text[];
  edge_id text;
  agent_node text;
  child_profile jsonb;
  child_definition jsonb;
begin
  if not plan ? 'repositorySets' then return new; end if;
  if jsonb_typeof(plan->'repositorySets') is distinct from 'object'
    or plan->'repositorySets' = '{}'::jsonb
    or not internal.is_bounded_factory_workflow_branch_graph(plan) then
    raise exception 'A bounded branch graph and repository sets are required.' using errcode = '22023';
  end if;
  select revision.definition_json::jsonb into strict root_definition
  from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id) =
    (new.workspace_id, new.factory_id, new.definition_revision_id);
  primary_repository := (root_definition->>'repositoryId')::uuid;
  if primary_repository is null then
    raise exception 'A primary repository is required for a repository set.' using errcode = '22023';
  end if;

  for group_entry in select key, value from jsonb_each(plan->'repositorySets') order by key loop
    if jsonb_typeof(group_entry.value) is distinct from 'array'
      or jsonb_array_length(group_entry.value) not between 1 and 8 then
      raise exception 'Each join must declare between one and eight secondary repositories.' using errcode = '22023';
    end if;
    select array_agg(branch->>'id'), array_agg(branch->>'id') filter (where branch->'required' = 'true'::jsonb)
    into eligible_edges, required_edges
    from jsonb_array_elements(plan->'edges') branch
    where branch->>'kind' = 'branch' and exists (
      select 1 from jsonb_array_elements(plan->'edges') output
      where (output->>'kind', output->>'from', output->>'to') =
        ('branch-result', branch->>'to', group_entry.key)
    );
    if eligible_edges is null then
      raise exception 'The repository set must identify an existing join.' using errcode = '22023';
    end if;
    assigned_edges := '{}'::text[];

    for specification in select value from jsonb_array_elements(group_entry.value) loop
      if jsonb_typeof(specification) is distinct from 'object'
        or jsonb_typeof(specification->'branchEdgeIds') is distinct from 'array'
        or jsonb_typeof(specification->'writerGrant') is distinct from 'object'
        or jsonb_typeof(specification#>'{writerGrant,version}') is distinct from 'number'
        or specification#>>'{writerGrant,version}' collate "C" !~ '^[1-9][0-9]{0,15}$'
        or jsonb_array_length(specification->'branchEdgeIds') not between 1 and 128 then
        raise exception 'Each secondary repository requires an exact writer and branch edges.' using errcode = '22023';
      end if;
      repository := (specification->>'repositoryId')::uuid;
      writer_id := (specification#>>'{writerGrant,id}')::uuid;
      writer_version := (specification#>>'{writerGrant,version}')::bigint;
      if repository is null or repository = primary_repository or writer_version not between 1 and 9007199254740991
        or not exists (
          select 1 from jsonb_array_elements(plan->'grants') grant_value
          where (grant_value->>'id', grant_value->'version') = (writer_id::text, to_jsonb(writer_version))
        ) then
        raise exception 'A secondary repository requires a distinct, declared writer.' using errcode = '22023';
      end if;
      writer := internal.require_current_factory_execution_grant(new.workspace_id, new.factory_id, writer_id,
        writer_version, repository, '{}'::uuid[], '{}'::text[], (root_definition->>'executionPolicyRevisionId')::uuid);
      perform 1 from internal.read_factory_workflow_repository_installation(new.workspace_id, new.factory_id, repository);
      if not found then
        raise exception 'The declared repository installation does not currently allow writing.' using errcode = '42501';
      end if;
      select array_agg(value order by value) into edge_ids
      from jsonb_array_elements_text(specification->'branchEdgeIds');
      if not (edge_ids <@ eligible_edges) or assigned_edges && edge_ids or not (edge_ids && required_edges)
        or cardinality(edge_ids) <> (select count(distinct value) from unnest(edge_ids) value) then
        raise exception 'Each secondary repository requires distinct branch edges and a required output.' using errcode = '22023';
      end if;
      assigned_edges := assigned_edges || edge_ids;

      foreach edge_id in array edge_ids loop
        select edge->>'to' into strict agent_node from jsonb_array_elements(plan->'edges') edge
        where edge->>'id' = edge_id;
        if not exists (select 1 from jsonb_array_elements(plan->'nodes') node
          where (node->>'id', node->>'kind', node->>'grantId') = (agent_node, 'agent', writer_id::text)) then
          raise exception 'The assigned branch must declare its repository writer.' using errcode = '22023';
        end if;
        child_profile := plan#>array['delegationPolicy', 'targets', agent_node];
        select revision.definition_json::jsonb into child_definition
        from public.factory_definition_revisions revision
        where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
          (new.workspace_id, new.factory_id, child_profile->>'definitionRevisionId', child_profile->>'definitionDigest');
        if not found or child_definition->>'repositoryId' is distinct from repository::text
          or (internal.resolve_definition_execution_grant(new.workspace_id, new.factory_id, child_definition,
            repository, writer.execution_policy_revision_id)).id is distinct from writer_id then
          raise exception 'The frozen branch profile does not own the declared repository writer.' using errcode = '42501';
        end if;
      end loop;

      insert into internal.factory_workflow_repository_writers
        (graph_revision_id, join_node_id, repository_id, branch_edge_ids, grant_id, grant_version)
      values (new.id, group_entry.key, repository, edge_ids, writer_id, writer_version);
    end loop;
    if required_edges <@ assigned_edges then
      raise exception 'The primary repository requires a branch with a required output.' using errcode = '22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function internal.project_factory_workflow_repository_writers() from public, anon, authenticated, service_role;
create trigger project_factory_workflow_repository_writers after insert on internal.factory_workflow_graph_revisions
  for each row execute function internal.project_factory_workflow_repository_writers();

create table internal.factory_workflow_branch_repository_bases (
  root_session_id uuid not null,
  group_id uuid not null,
  repository_id uuid not null,
  installation_id uuid not null,
  installation_numeric_id bigint not null,
  repository_numeric_id bigint not null,
  repository_full_name text not null,
  head_receipt_id uuid not null,
  base_branch text not null,
  initial_base_sha text not null,
  input_sha text not null,
  input_ref text,
  primary key (root_session_id, group_id, repository_id),
  foreign key (root_session_id, group_id)
    references internal.factory_workflow_branch_groups(root_session_id, group_id) on delete cascade
);
alter table internal.factory_workflow_branch_repository_bases enable row level security;
revoke all on table internal.factory_workflow_branch_repository_bases from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_branch_repository_base
  before update on internal.factory_workflow_branch_repository_bases
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.lock_factory_workflow_branch_repository_writer(
  p_execution internal.factory_workflow_executions, p_group internal.factory_workflow_branch_groups,
  p_repository_id uuid
) returns internal.factory_workflow_repository_writers
language plpgsql set search_path = '' as $$
declare
  writer internal.factory_workflow_repository_writers;
  approved public.factory_execution_grants;
  parent_input public.session_factory_admission_inputs;
begin
  select declared.* into writer from internal.factory_workflow_repository_writers declared
  where (declared.graph_revision_id, declared.join_node_id, declared.repository_id) =
    (p_execution.graph_revision_id, p_group.join_node_id, p_repository_id);
  if not found or p_repository_id = p_group.repository_id or
    not internal.recheck_factory_workflow_delegation_lineage(p_group.root_session_id,
      p_group.workspace_id, p_group.factory_id, p_group.parent_session_id) then
    return null;
  end if;
  select pin.* into strict parent_input from public.session_factory_admission_inputs pin
  where (pin.session_id, pin.workspace_id, pin.factory_id) =
    (p_group.parent_session_id, p_group.workspace_id, p_group.factory_id);
  approved := internal.require_current_factory_execution_grant(p_group.workspace_id, p_group.factory_id,
    writer.grant_id, writer.grant_version, p_repository_id, '{}'::uuid[], '{}'::text[],
    parent_input.execution_policy_revision_id);
  if (approved.service_principal_id, approved.budget_payer_member_id) is distinct from
    (parent_input.credential_owner_service_principal_id, parent_input.budget_payer_member_id) then
    return null;
  end if;
  return writer;
exception when insufficient_privilege then
  return null;
end;
$$;
revoke all on function internal.lock_factory_workflow_branch_repository_writer(
  internal.factory_workflow_executions, internal.factory_workflow_branch_groups, uuid)
  from public, anon, authenticated, service_role;

-- Returning scope and identity to the trusted worker permits one read-only Git observation.
-- The caller need not resolve a default branch when an exact accepted receipt already exists.
create function public.list_factory_workflow_branch_repository_bases()
returns table(root_session_id uuid, workspace_id uuid, factory_id uuid, group_id uuid, generation bigint,
  repository_id uuid, repository_full_name text, repository_numeric_id bigint, installation_id uuid,
  installation_numeric_id bigint, base_branch text, requires_observation boolean)
language plpgsql security definer set search_path = '' as $$
declare candidate record;
begin
  perform internal.assert_checkpoint_publication_service();
  for candidate in
    select workflow as execution, manifest as branch_group, writer.repository_id as repo_id
    from internal.factory_workflow_branch_groups manifest
    join internal.factory_workflow_executions workflow using (root_session_id)
    join internal.factory_workflow_repository_writers writer
      on (writer.graph_revision_id, writer.join_node_id) = (workflow.graph_revision_id, manifest.join_node_id)
    join internal.factory_workflow_branch_dispatches dispatch
      on (dispatch.root_session_id, dispatch.branch_occurrence_id) = (manifest.root_session_id, manifest.branch_occurrence_id)
    join public.workspaces workspace on workspace.id = workflow.workspace_id
    where workflow.lifecycle_status = 'running' and workspace.deletion_requested_at is null
      and dispatch.completed_at is null
      and not exists (select 1 from internal.factory_workflow_branch_repository_bases prior
        where (prior.root_session_id, prior.group_id, prior.repository_id) =
          (manifest.root_session_id, manifest.group_id, writer.repository_id))
    order by dispatch.due_at, manifest.root_session_id, writer.repository_id
    limit 16
  loop
    begin
      if (internal.lock_factory_workflow_branch_repository_writer(candidate.execution, candidate.branch_group,
        candidate.repo_id)).grant_id is null then continue; end if;
      return query select (candidate.branch_group).root_session_id, (candidate.branch_group).workspace_id,
        (candidate.branch_group).factory_id, (candidate.branch_group).group_id, (candidate.execution).generation,
        candidate.repo_id, connection.repository_full_name, connection.repository_numeric_id, connection.installation_id,
        connection.installation_numeric_id, coalesce(head.base_branch, repo.default_branch), head.receipt_id is null
      from internal.read_factory_workflow_repository_installation((candidate.branch_group).workspace_id,
        (candidate.branch_group).factory_id, candidate.repo_id) connection
      join public.github_repositories repo on repo.id = candidate.repo_id
      left join internal.factory_workflow_secondary_repository_heads head
        on (head.root_session_id, head.parent_session_id, head.repository_id) =
          ((candidate.branch_group).root_session_id, (candidate.branch_group).parent_session_id, candidate.repo_id)
      where coalesce(head.base_branch, repo.default_branch) is not null;
    exception when lock_not_available then
      continue;
    end;
  end loop;
end;
$$;

create function public.pin_factory_workflow_branch_repository_base(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_group_id uuid,
  p_expected_generation bigint, p_repository_id uuid, p_installation_id uuid, p_installation_numeric_id bigint,
  p_repository_numeric_id bigint, p_base_branch text, p_observed_sha text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  head internal.factory_workflow_secondary_repository_heads;
  connection record;
  prior internal.factory_workflow_branch_repository_bases;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.sessions owner
  where (owner.id, owner.workspace_id, owner.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
  for no key update;
  select state.* into execution from internal.factory_workflow_executions state
  where (state.root_session_id, state.workspace_id, state.factory_id, state.generation, state.lifecycle_status) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_expected_generation, 'running') for no key update;
  if not found then return false; end if;
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.group_id) = (p_root_session_id, p_group_id);
  if not found or (internal.lock_factory_workflow_branch_repository_writer(execution, manifest, p_repository_id)).grant_id
      is null then return false; end if;
  select * into connection from internal.read_factory_workflow_repository_installation(p_workspace_id, p_factory_id, p_repository_id);
  if not found or (connection.installation_id, connection.installation_numeric_id, connection.repository_numeric_id)
    is distinct from (p_installation_id, p_installation_numeric_id, p_repository_numeric_id) then return false; end if;

  select * into prior from internal.factory_workflow_branch_repository_bases
  where (root_session_id, group_id, repository_id) = (p_root_session_id, p_group_id, p_repository_id);
  if found then
    return (prior.installation_id, prior.installation_numeric_id, prior.repository_numeric_id, prior.repository_full_name,
      prior.base_branch) is not distinct from (p_installation_id, p_installation_numeric_id, p_repository_numeric_id,
      connection.repository_full_name, p_base_branch)
      and (p_observed_sha is null or prior.input_sha = p_observed_sha);
  end if;

  select * into head from internal.factory_workflow_secondary_repository_heads
  where (root_session_id, parent_session_id, repository_id) = (p_root_session_id, manifest.parent_session_id, p_repository_id)
  for update;
  if not found then
    if p_observed_sha is null or p_observed_sha collate "C" !~ '^[a-f0-9]{40}$'
      or not exists (select 1 from public.github_repositories repo where repo.id = p_repository_id
        and repo.default_branch = p_base_branch) then return false; end if;
    insert into internal.factory_workflow_secondary_repository_heads
      (root_session_id, parent_session_id, workspace_id, factory_id, repository_id, base_branch, initial_base_sha, accepted_sha)
    values (p_root_session_id, manifest.parent_session_id, p_workspace_id, p_factory_id, p_repository_id,
      p_base_branch, p_observed_sha, p_observed_sha) returning * into head;
  elsif head.base_branch is distinct from p_base_branch
    or (p_observed_sha is not null and head.accepted_sha <> p_observed_sha) then return false;
  end if;

  insert into internal.factory_workflow_branch_repository_bases
    (root_session_id, group_id, repository_id, installation_id, installation_numeric_id, repository_numeric_id,
      repository_full_name, head_receipt_id, base_branch, initial_base_sha, input_sha, input_ref)
  values (p_root_session_id, p_group_id, p_repository_id, p_installation_id, p_installation_numeric_id,
    p_repository_numeric_id, connection.repository_full_name, head.receipt_id, head.base_branch, head.initial_base_sha,
    head.accepted_sha, head.fetch_ref);
  return true;
end;
$$;

revoke all on function public.list_factory_workflow_branch_repository_bases(),
  public.pin_factory_workflow_branch_repository_base(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_workflow_branch_repository_bases(),
  public.pin_factory_workflow_branch_repository_base(uuid, uuid, uuid, uuid, bigint, uuid, uuid, bigint, bigint, text, text)
  to service_role;

create or replace function internal.freeze_factory_workflow_delegation_source()
returns trigger language plpgsql set search_path = '' as $$
declare child public.sessions; source record; secondary internal.factory_workflow_branch_repository_bases;
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.sessions where id = old.child_session_id) then return old; end if;
    raise exception 'The delegated workflow source is immutable.' using errcode='23514';
  end if;
  if tg_op = 'UPDATE' then
    raise exception 'The delegated workflow source is immutable.' using errcode='23514';
  end if;

  -- Admission must run root, parent, child in this order. None of the source
  -- read paths acquire an ancestor lock after acquiring a child/job lock.
  perform 1 from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.root_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production'
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.phase_status <> 'rejected'
  for no key update;
  if not found then raise exception 'Delegated workflow root is unavailable.' using errcode='42501'; end if;
  perform 1 from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.parent_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production'
    and (session.archived_at is null or session.phase_status = 'approved')
    and session.phase_status <> 'rejected'
  for no key update;
  if not found or (new.parent_session_id <> new.root_session_id and not exists (
    select 1 from internal.factory_workflow_delegations parent
    where (parent.child_session_id, parent.workspace_id, parent.factory_id, parent.root_session_id) =
      (new.parent_session_id, new.workspace_id, new.factory_id, new.root_session_id)
  )) then
    raise exception 'Delegated workflow parent is unavailable in this root.' using errcode='42501';
  end if;

  select session.* into child from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) =
    (new.child_session_id, new.workspace_id, new.factory_id)
    and session.execution_purpose = 'production' and session.archived_at is null
  for no key update;
  if not found or exists (select 1 from public.session_git_roots where session_id = new.child_session_id)
    or exists (select 1 from public.session_pull_requests where session_id = new.child_session_id)
    or exists (select 1 from public.session_pr_sync where session_id = new.child_session_id)
    or exists (select 1 from public.agent_jobs where session_id = new.child_session_id and status <> 'queued')
  then
    raise exception 'Delegation requires a fresh child session.' using errcode='23514';
  end if;

  if new.source_branch_slot_id is not null then
    select base.* into secondary from internal.factory_workflow_branch_slots slot
    join internal.factory_workflow_branch_groups manifest
      on (manifest.root_session_id, manifest.group_id) = (slot.root_session_id, slot.group_id)
    join internal.factory_workflow_executions execution on execution.root_session_id = slot.root_session_id
    join internal.factory_workflow_repository_writers writer
      on (writer.graph_revision_id, writer.join_node_id) = (execution.graph_revision_id, manifest.join_node_id)
        and slot.branch_edge_id = any(writer.branch_edge_ids)
    join internal.factory_workflow_branch_repository_bases base
      on (base.root_session_id, base.group_id, base.repository_id) =
        (slot.root_session_id, slot.group_id, writer.repository_id)
    where (slot.root_session_id, slot.slot_id, manifest.workspace_id, manifest.factory_id, manifest.parent_session_id,
      manifest.source_checkpoint_run_id) = (new.root_session_id, new.source_branch_slot_id, new.workspace_id,
      new.factory_id, new.parent_session_id, new.source_checkpoint_run_id);
  end if;
  if secondary.repository_id is null then
    select * into strict source from internal.checkpoint_execution_input(
      new.source_checkpoint_run_id, new.parent_session_id, new.workspace_id);
    new.repository_id := source.repository_id;
    new.repository_full_name := source.repository_full_name;
    new.base_branch := source.base_branch;
    new.initial_base_sha := source.initial_base_sha;
    new.input_sha := source.input_sha;
    new.input_ref := source.input_ref;
  else
    -- Keep the primary checkpoint as causal ancestry. Git input comes from the
    -- repository cursor sealed before this branch slot could be admitted.
    new.repository_id := secondary.repository_id;
    new.repository_full_name := secondary.repository_full_name;
    new.base_branch := secondary.base_branch;
    new.initial_base_sha := secondary.initial_base_sha;
    new.input_sha := secondary.input_sha;
    new.input_ref := secondary.input_ref;
  end if;
  if internal.session_writable_repository_id(child) is distinct from new.repository_id then
    raise exception 'Delegated source repository does not match the child.' using errcode='42501';
  end if;
  return new;
end;
$$;

create or replace function internal.create_factory_workflow_child(
  execution internal.factory_workflow_executions, p_parent_session_id uuid, p_target_occurrence_id uuid,
  p_target_node_id text, p_source_checkpoint_run_id uuid, source_repository_id uuid,
  p_source_transition_id uuid, p_source_route_occurrence_id uuid, p_source_route_decision_id uuid,
  p_source_branch_slot_id uuid, p_title text, p_prompt_md text, intent_title_hash text, intent_prompt_hash text
) returns table(child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql set search_path = '' as $$
declare
  p_root_session_id uuid := execution.root_session_id;
  p_workspace_id uuid := execution.workspace_id;
  p_factory_id uuid := execution.factory_id;
  root public.sessions;
  parent public.sessions;
  plan jsonb;
  target_node jsonb;
  target_profile jsonb;
  existing_children bigint;
  child_profile public.factory_definition_revisions;
  root_definition jsonb;
  parent_definition jsonb;
  child_definition jsonb;
  actual_child_definition jsonb;
  root_grant public.factory_execution_grants;
  parent_grant public.factory_execution_grants;
  child_grant public.factory_execution_grants;
  root_envelope public.factory_execution_grants;
  parent_envelope public.factory_execution_grants;
  secondary_writer internal.factory_workflow_repository_writers;
  actor internal.session_mutation_actor;
  child record;
begin
  select session.* into strict root from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id);
  select session.* into strict parent from public.sessions session
  where (session.id, session.workspace_id, session.factory_id) = (p_parent_session_id, p_workspace_id, p_factory_id);
  plan := execution.workflow_json::jsonb;
  select node into strict target_node from jsonb_array_elements(plan->'nodes') node where node->>'id' = p_target_node_id;
  target_profile := plan#>array['delegationPolicy', 'targets', p_target_node_id];
  select count(*) into existing_children from internal.factory_workflow_delegations receipt
  where receipt.root_session_id = p_root_session_id;
  if existing_children >= (plan#>>'{delegationPolicy,maxChildren}')::integer then
    raise exception 'The workflow root has no remaining delegated child capacity.'
      using errcode = 'PT409', detail = 'workflow_child_limit';
  end if;
  select revision.* into child_profile from public.factory_definition_revisions revision
  where (revision.workspace_id, revision.factory_id, revision.id::text, revision.canonical_digest) =
    (p_workspace_id, p_factory_id, target_profile->>'definitionRevisionId', target_profile->>'definitionDigest')
    and exists (select 1 from public.factory_definition_activations activation
      where (activation.workspace_id, activation.factory_id, activation.revision_id) =
        (revision.workspace_id, revision.factory_id, revision.id));
  child_definition := child_profile.definition_json::jsonb;
  if not found or child_definition#>>'{implementationAgent,promptRevisionId}' is distinct from target_node->>'agentPromptRevisionId'
    or child_definition#>>'{implementationAgent,agentId}' is null
    or child_definition->>'repositoryId' is distinct from source_repository_id::text then
    raise exception 'The frozen child profile does not match the declared agent and parent source.' using errcode = 'PT422';
  end if;
  if exists (select 1 from public.delivery_policy_revisions delivery
    where (delivery.id::text, delivery.workspace_id) = (child_definition->>'deliveryPolicyRevisionId', p_workspace_id)
      and delivery.requirements->>'deliveryMode' = 'code'
      and delivery.requirements->'requireArtifactApprovalForDelivery' = 'true'::jsonb) then
    raise exception 'The child delivery policy requires a pull request that delegated children cannot publish.' using errcode = 'PT422';
  end if;

  root_definition := internal.pinned_session_execution_definition(root);
  select grant_row.* into root_grant from public.session_factory_admission_inputs pin
  join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
    (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
  where pin.session_id = root.id;
  if parent.id = root.id then
    parent_definition := root_definition;
    parent_grant := root_grant;
  else
    parent_definition := internal.pinned_session_execution_definition(parent);
    select grant_row.* into parent_grant from public.session_factory_admission_inputs pin
    join public.factory_execution_grants grant_row on (grant_row.workspace_id, grant_row.factory_id, grant_row.id, grant_row.version) =
      (pin.workspace_id, pin.factory_id, pin.execution_grant_id, pin.execution_grant_version)
    where pin.session_id = parent.id;
  end if;
  child_grant := internal.resolve_definition_execution_grant(p_workspace_id, p_factory_id, child_definition,
    source_repository_id, (child_definition->>'executionPolicyRevisionId')::uuid);
  root_envelope := root_grant;
  parent_envelope := parent_grant;
  if source_repository_id is distinct from parent_grant.github_repository_id and p_source_branch_slot_id is not null then
    select writer.* into secondary_writer from internal.factory_workflow_branch_slots slot
    join internal.factory_workflow_branch_groups manifest
      on (manifest.root_session_id, manifest.group_id) = (slot.root_session_id, slot.group_id)
    join internal.factory_workflow_repository_writers writer
      on (writer.graph_revision_id, writer.join_node_id, writer.repository_id) =
        (execution.graph_revision_id, manifest.join_node_id, source_repository_id)
      and slot.branch_edge_id = any(writer.branch_edge_ids)
    where (slot.root_session_id, slot.slot_id, manifest.parent_session_id, manifest.source_checkpoint_run_id) =
      (p_root_session_id, p_source_branch_slot_id, p_parent_session_id, p_source_checkpoint_run_id);
    if (secondary_writer.grant_id, secondary_writer.grant_version) is distinct from (child_grant.id, child_grant.version) then
      raise exception 'The branch has no exact approved repository writer.' using errcode = '42501';
    end if;
    -- The explicit graph writer grants this one repository. Every other
    -- inherited bound still applies to the original root and parent grants.
    root_envelope.github_repository_id := source_repository_id;
    parent_envelope.github_repository_id := source_repository_id;
  end if;
  if internal.factory_workflow_delegated_scope_is_subset(child_grant, root_envelope, child_definition, root_definition) is not true
    or internal.factory_workflow_delegated_scope_is_subset(child_grant, parent_envelope, child_definition, parent_definition) is not true
    or (target_node ? 'grantId' and not exists (
      select 1 from jsonb_array_elements(plan->'grants') declared
      where (declared->>'id', declared->'version') =
        (coalesce(secondary_writer.grant_id, root_grant.id)::text,
          to_jsonb(coalesce(secondary_writer.grant_version, root_grant.version)))
        and declared->>'id' = target_node->>'grantId'
    )) then
    raise exception 'The frozen child profile exceeds inherited execution authority.' using errcode = '42501';
  end if;
  perform internal.lock_definition_credential_binding(p_workspace_id, p_factory_id, child_definition,
    child_grant.id, child_grant.service_principal_id);

  actor := row(p_workspace_id, p_factory_id, null, child_grant.service_principal_id, null,
    child_grant.id, child_grant.version, source_repository_id, null)::internal.session_mutation_actor;
  select * into strict child from internal.create_attributed_session_from_profile(
    p_workspace_id, null, p_title, p_prompt_md, child_definition#>>'{agent,provider}', child_definition#>>'{agent,model}',
    null, null, source_repository_id, null, null, actor, (child_definition#>>'{implementationAgent,agentId}')::uuid,
    child_profile.canonical_digest, child_profile.id);
  select internal.pinned_session_execution_definition(session) into strict actual_child_definition
  from public.sessions session where session.id = child.session_id;
  if actual_child_definition is distinct from child_definition then
    raise exception 'The admitted child must retain the exact frozen execution profile.' using errcode = 'PT422';
  end if;

  insert into internal.factory_workflow_delegations (
    child_session_id, workspace_id, factory_id, root_session_id, parent_session_id, target_occurrence_id,
    source_route_occurrence_id, source_route_decision_id, source_transition_id, source_checkpoint_run_id, source_branch_slot_id,
    child_definition_revision_id, child_definition_digest, child_job_id, child_run_id,
    title_sha256, prompt_sha256, recorded_generation
  ) values (
    child.session_id, p_workspace_id, p_factory_id, p_root_session_id, parent.id, p_target_occurrence_id,
    p_source_route_occurrence_id, p_source_route_decision_id, p_source_transition_id, p_source_checkpoint_run_id, p_source_branch_slot_id,
    child_profile.id, child_profile.canonical_digest, child.job_id, child.run_id,
    intent_title_hash, intent_prompt_hash, execution.generation
  );
  perform internal.prepare_session_job_git_input(child.job_id);
  if not internal.reserve_factory_workflow_attempt(execution, child.session_id, child.job_id, 1) then
    raise exception 'The workflow root has no remaining child attempt capacity.'
      using errcode = 'PT409', detail = 'workflow_child_attempt_limit';
  end if;
  return query select child.session_id::uuid, child.job_id::uuid, child.run_id::uuid, true;
end;
$$;

create or replace function public.admit_factory_workflow_branch_slot(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_expected_generation bigint,
  p_ownership_token uuid, p_group_id uuid, p_branch_edge_id text
) returns table(target_occurrence_id uuid, child_session_id uuid, job_id uuid, run_id uuid, created boolean)
language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_branch_groups;
  slot internal.factory_workflow_branch_slots;
  prior internal.factory_workflow_delegations;
  transition internal.factory_workflow_transition_receipts;
  predecessor_result_id uuid;
  occurrence_id uuid;
  decision_edge jsonb;
  target jsonb;
  branch_repository_id uuid;
  base internal.factory_workflow_branch_repository_bases;
  connection record;
  parent_input public.session_factory_admission_inputs;
  terminal_blocker text;
  title text;
  prompt text;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id,
    p_expected_generation, p_ownership_token);
  select groups.* into manifest from internal.factory_workflow_branch_groups groups
  where (groups.root_session_id, groups.workspace_id, groups.factory_id, groups.group_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_group_id);
  if not found then raise exception 'The workflow branch group is unavailable.' using errcode = 'PT404'; end if;
  select slots.* into slot from internal.factory_workflow_branch_slots slots
  where (slots.root_session_id, slots.group_id, slots.branch_edge_id) =
    (p_root_session_id, p_group_id, p_branch_edge_id);
  if not found then raise exception 'The workflow branch slot is unavailable.' using errcode = 'PT404'; end if;
  select marker.* into prior from internal.factory_workflow_delegations marker
  where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.source_branch_slot_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, slot.slot_id);
  if found then
    return query select prior.target_occurrence_id, prior.child_session_id, prior.child_job_id, prior.child_run_id, false;
    return;
  end if;
  select state.terminal_blocker into terminal_blocker
  from internal.factory_workflow_branch_slot_dispatches state
  where (state.root_session_id, state.slot_id) = (p_root_session_id, slot.slot_id);
  if terminal_blocker is not null then
    raise exception 'The workflow branch slot has reached its lifetime limit.'
      using errcode = 'PT409', detail = terminal_blocker;
  end if;

  -- Ready mandatory work takes the next capacity within this group.
  if not slot.required and exists (
    select 1 from internal.factory_workflow_branch_slots pending
    where (pending.root_session_id, pending.group_id) = (p_root_session_id, p_group_id)
      and pending.required and not exists (
        select 1 from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.source_branch_slot_id) = (p_root_session_id, pending.slot_id)
      )
  ) then return; end if;

  if not internal.recheck_factory_workflow_delegation_lineage(p_root_session_id, p_workspace_id, p_factory_id, manifest.parent_session_id) then
    raise exception 'The branch parent is unavailable.' using errcode = 'PT409';
  end if;
  select writer.repository_id into branch_repository_id
  from internal.factory_workflow_repository_writers writer
  where (writer.graph_revision_id, writer.join_node_id) = (execution.graph_revision_id, manifest.join_node_id)
    and slot.branch_edge_id = any(writer.branch_edge_ids);
  if branch_repository_id is not null then
    select pinned.* into base from internal.factory_workflow_branch_repository_bases pinned
    where (pinned.root_session_id, pinned.group_id, pinned.repository_id) =
      (p_root_session_id, p_group_id, branch_repository_id);
    if not found then return; end if;
    if (internal.lock_factory_workflow_branch_repository_writer(execution, manifest, branch_repository_id)).grant_id
      is null then
      raise exception 'The branch repository authority is unavailable.' using errcode = '42501';
    end if;
    select * into connection from internal.read_factory_workflow_repository_installation(
      p_workspace_id, p_factory_id, branch_repository_id);
    if not found or (connection.installation_id, connection.installation_numeric_id, connection.repository_numeric_id,
        connection.repository_full_name) is distinct from
      (base.installation_id, base.installation_numeric_id, base.repository_numeric_id, base.repository_full_name)
      or not exists (select 1 from internal.factory_workflow_secondary_repository_heads head
        where (head.root_session_id, head.parent_session_id, head.repository_id, head.receipt_id) =
          (p_root_session_id, manifest.parent_session_id, branch_repository_id, base.head_receipt_id)) then
      raise exception 'The frozen branch repository base is unavailable.' using errcode = 'PT409';
    end if;
  else
    branch_repository_id := manifest.repository_id;
  end if;
  select edge into strict decision_edge from jsonb_array_elements(execution.workflow_json::jsonb->'edges') edge
  where edge->>'id' = slot.branch_edge_id and edge->>'kind' = 'branch' and edge->>'to' = slot.target_node_id;
  target := execution.workflow_json::jsonb#>array['delegationPolicy', 'targets', slot.target_node_id];
  if (target->>'definitionRevisionId', target->>'definitionDigest') is distinct from
    (slot.child_definition_revision_id::text, slot.child_definition_digest) then
    raise exception 'The frozen branch target profile is unavailable.' using errcode = 'PT409';
  end if;
  select result.result_id into strict predecessor_result_id from internal.factory_workflow_node_results result
  where (result.root_session_id, result.occurrence_id, result.evidence_ref) =
    (p_root_session_id, manifest.branch_occurrence_id, 'branch-manifest:' || manifest.group_id)
    and result.outcome = 'succeeded';
  perform internal.assert_factory_workflow_route_capacity(execution, decision_edge);

  select pin.* into strict parent_input from public.session_factory_admission_inputs pin
  where (pin.session_id, pin.workspace_id, pin.factory_id) = (manifest.parent_session_id, p_workspace_id, p_factory_id);
  title := left('Branch ' || slot.target_node_id || ': ' || parent_input.original_title, 200);
  prompt := left(btrim(parent_input.original_prompt_md), 20000);

  -- The root's initial intake may contradict the clarified scope. Its branch
  -- task comes from the exact approved scope. Nested branches retain the
  -- narrower task already assigned to their immediate parent.
  if manifest.parent_session_id = p_root_session_id and exists (
    select 1 from internal.factory_workflow_triage_bindings binding
    where (binding.session_id, binding.workspace_id, binding.factory_id) =
      (p_root_session_id, p_workspace_id, p_factory_id)
  ) then
    title := 'Branch ' || slot.target_node_id;
    select saved.scope->>'scope' into prompt from internal.factory_workflow_accepted_scopes saved
    where (saved.session_id, saved.workspace_id, saved.factory_id, saved.graph_revision_id, saved.workflow_digest, saved.run_id) =
      (p_root_session_id, p_workspace_id, p_factory_id, execution.graph_revision_id, execution.workflow_digest,
        execution.graph_input_run_id);
    if not found or prompt is null then
      raise exception 'The branch task requires its exact approved scope.' using errcode = 'PT409';
    end if;
  end if;

  insert into internal.factory_workflow_node_occurrences(root_session_id, node_id, node_kind, admitted_generation)
  values (p_root_session_id, slot.target_node_id, 'agent', execution.generation)
  returning factory_workflow_node_occurrences.occurrence_id into occurrence_id;
  insert into internal.factory_workflow_transition_receipts(
    root_session_id, source_occurrence_id, edge_id, source_result_id, edge_kind, target_occurrence_id, recorded_generation
  ) values (
    p_root_session_id, manifest.branch_occurrence_id, slot.branch_edge_id, predecessor_result_id, 'branch', occurrence_id,
    execution.generation
  ) returning * into transition;

  return query select occurrence_id, child.* from internal.create_factory_workflow_child(
    execution, manifest.parent_session_id, occurrence_id, slot.target_node_id, manifest.source_checkpoint_run_id,
    branch_repository_id, transition.transition_id, null, null, slot.slot_id, title, prompt,
    encode(sha256(convert_to(btrim(title), 'UTF8')), 'hex'),
    encode(sha256(convert_to(btrim(prompt), 'UTF8')), 'hex')
  ) child;
end;
$$;

create or replace function public.read_factory_workflow_join(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_join_id uuid
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('manifest', to_jsonb(manifest), 'attempt', to_jsonb(attempt),
    'candidate', to_jsonb(candidate), 'outcome', to_jsonb(terminal),
    'inputs', (select jsonb_agg(to_jsonb(input) || jsonb_build_object(
        'branchOutput', to_jsonb(output), 'repository_id', coalesce(writer.repository_id, manifest.repository_id))
      order by input.branch_edge_id)
      from internal.factory_workflow_join_inputs input left join internal.factory_workflow_branch_outcomes output
        on (output.root_session_id, output.outcome_id) = (input.root_session_id, input.outcome_id)
      left join internal.factory_workflow_executions execution on execution.root_session_id = input.root_session_id
      left join internal.factory_workflow_branch_groups branch_group
        on (branch_group.root_session_id, branch_group.group_id) = (manifest.root_session_id, manifest.branch_group_id)
      left join internal.factory_workflow_repository_writers writer
        on (writer.graph_revision_id, writer.join_node_id) = (execution.graph_revision_id, branch_group.join_node_id)
        and input.branch_edge_id = any(writer.branch_edge_ids)
      where (input.root_session_id, input.join_id) = (manifest.root_session_id, manifest.join_id)))
  from internal.factory_workflow_joins manifest
  left join internal.factory_workflow_join_attempts attempt using (root_session_id, join_id)
  left join internal.factory_workflow_join_candidates candidate using (root_session_id, join_id)
  left join internal.factory_workflow_join_outcomes terminal using (root_session_id, join_id)
  where (manifest.root_session_id, manifest.workspace_id, manifest.factory_id, manifest.join_id) =
    (p_root_session_id, p_workspace_id, p_factory_id, p_join_id)
$$;

-- Commit all declared obligations in the admission transaction, even if the
-- worker disappears before claiming the primary job.
create function internal.pin_factory_workflow_repository_delivery_targets()
returns trigger language plpgsql set search_path = '' as $$
declare
  target record;
begin
  for target in
    select writer.repository_id, writer.grant_id, writer.grant_version, base as pin
    from internal.factory_workflow_executions execution
    join internal.factory_workflow_branch_groups branch_group
      on (branch_group.root_session_id, branch_group.group_id) = (execution.root_session_id, new.branch_group_id)
    join internal.factory_workflow_repository_writers writer
      on (writer.graph_revision_id, writer.join_node_id) = (execution.graph_revision_id, branch_group.join_node_id)
    left join internal.factory_workflow_branch_repository_bases base
      on (base.root_session_id, base.group_id, base.repository_id) = (new.root_session_id, new.branch_group_id, writer.repository_id)
    where execution.root_session_id = new.root_session_id
    order by writer.repository_id
  loop
    if (target.pin).head_receipt_id is null then
      raise exception 'Every secondary branch repository requires an observed base.' using errcode = 'PT409';
    end if;
    insert into internal.factory_workflow_repository_delivery_targets
      (root_session_id, join_id, repository_id, parent_session_id, workspace_id, factory_id, grant_id, grant_version,
        installation_id, installation_numeric_id, repository_numeric_id, repository_full_name, expected_head_receipt_id,
        base_sha, base_branch, base_fetch_ref, deadline_at)
    values (new.root_session_id, new.join_id, target.repository_id, new.parent_session_id, new.workspace_id, new.factory_id,
      target.grant_id, target.grant_version, (target.pin).installation_id, (target.pin).installation_numeric_id,
      (target.pin).repository_numeric_id, (target.pin).repository_full_name, (target.pin).head_receipt_id,
      (target.pin).input_sha, (target.pin).base_branch, (target.pin).input_ref, new.admitted_at + interval '30 minutes');
    insert into internal.factory_workflow_repository_delivery_state (root_session_id, join_id, repository_id)
    values (new.root_session_id, new.join_id, target.repository_id);
  end loop;
  return new;
end;
$$;
revoke all on function internal.pin_factory_workflow_repository_delivery_targets() from public, anon, authenticated, service_role;
create trigger pin_factory_workflow_repository_delivery_targets after insert on internal.factory_workflow_joins
  for each row execute function internal.pin_factory_workflow_repository_delivery_targets();

-- The primary artifact may be reviewed while secondary delivery is partial.
-- Guarded graph continuation needs a successful result for the whole set.
create function internal.wait_for_factory_workflow_repository_results()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.outcome = 'succeeded' and exists (
    select 1 from internal.factory_workflow_joins manifest
    join internal.factory_workflow_repository_delivery_state delivery using (root_session_id, join_id)
    where (manifest.root_session_id, manifest.join_occurrence_id) = (new.root_session_id, new.occurrence_id)
      and delivery.status <> 'adopted'
  ) then return null; end if;
  return new;
end;
$$;
revoke all on function internal.wait_for_factory_workflow_repository_results() from public, anon, authenticated, service_role;
create trigger wait_for_factory_workflow_repository_results before insert on internal.factory_workflow_node_results
  for each row execute function internal.wait_for_factory_workflow_repository_results();

create function internal.record_factory_workflow_repository_result()
returns trigger language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  checkpoint_run_id uuid;
begin
  if new.status <> 'adopted' then return new; end if;
  if exists (select 1 from internal.factory_workflow_repository_delivery_state other
    where (other.root_session_id, other.join_id) = (new.root_session_id, new.join_id) and other.status <> 'adopted')
  then return new; end if;
  select * into strict execution from internal.factory_workflow_executions where root_session_id = new.root_session_id;
  select * into strict manifest from internal.factory_workflow_joins
  where (root_session_id, join_id) = (new.root_session_id, new.join_id);
  select terminal.checkpoint_run_id into strict checkpoint_run_id
  from internal.factory_workflow_join_outcomes terminal
  where (terminal.root_session_id, terminal.join_id, terminal.outcome) = (new.root_session_id, new.join_id, 'adopted');
  perform internal.insert_factory_workflow_node_result(execution, manifest.join_occurrence_id, 'succeeded',
    'join-checkpoint:' || checkpoint_run_id);
  return new;
end;
$$;
revoke all on function internal.record_factory_workflow_repository_result() from public, anon, authenticated, service_role;
create trigger record_factory_workflow_repository_result after update of status
  on internal.factory_workflow_repository_delivery_state for each row
  when (old.status is distinct from new.status) execute function internal.record_factory_workflow_repository_result();

create table internal.factory_workflow_repository_validation_jobs (
  job_id uuid primary key references public.agent_jobs(id) on delete cascade,
  session_id uuid not null unique references public.sessions(id) on delete cascade,
  queued_run_id uuid not null unique references public.agent_runs(id) on delete cascade,
  root_session_id uuid not null,
  join_id uuid not null,
  repository_id uuid not null,
  admitted_generation bigint not null check (admitted_generation > 0),
  unique (root_session_id, join_id, repository_id, admitted_generation),
  foreign key (root_session_id, join_id, repository_id)
    references internal.factory_workflow_repository_delivery_targets(root_session_id, join_id, repository_id) on delete cascade
);
alter table internal.factory_workflow_repository_validation_jobs enable row level security;
revoke all on table internal.factory_workflow_repository_validation_jobs from public, anon, authenticated, service_role;
create trigger freeze_factory_workflow_repository_validation_job before update
  on internal.factory_workflow_repository_validation_jobs
  for each row execute function internal.reject_factory_workflow_join_update();

create function internal.is_factory_workflow_repository_validation_job(p_job_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from internal.factory_workflow_repository_validation_jobs marker where marker.job_id = p_job_id)
$$;
revoke all on function internal.is_factory_workflow_repository_validation_job(uuid) from public, anon, authenticated, service_role;
grant execute on function internal.is_factory_workflow_repository_validation_job(uuid) to service_role;

create or replace function public.start_session_job_attempt(
  p_job_id uuid, p_attempt_count integer, p_expected_stage_id uuid, p_expected_artifact_version integer,
  p_model_provider text, p_model_name text, p_run_type text, p_branch_name text default null
) returns uuid language sql security invoker set search_path = '' as $$
  select case when not (internal.is_factory_workflow_join_job(p_job_id)
    or internal.is_factory_workflow_repository_validation_job(p_job_id))
    then internal.start_session_job_attempt(p_job_id, p_attempt_count, p_expected_stage_id, p_expected_artifact_version,
      p_model_provider, p_model_name, p_run_type, p_branch_name) end
$$;

create or replace function internal.workflow_session_can_publish_pull_request(p_session_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select not exists (select 1 from internal.factory_workflow_delegations marker where marker.child_session_id = p_session_id)
    and not exists (select 1 from internal.factory_workflow_repository_validation_jobs marker where marker.session_id = p_session_id)
$$;

create function internal.reject_factory_workflow_repository_validation_checkpoint()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if internal.is_factory_workflow_repository_validation_job(new.job_id) then
    raise exception 'Repository validation jobs cannot publish session checkpoints.' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function internal.reject_factory_workflow_repository_validation_checkpoint()
  from public, anon, authenticated, service_role;
create trigger reject_factory_workflow_repository_validation_checkpoint
  before insert on public.session_git_checkpoints
  for each row execute function internal.reject_factory_workflow_repository_validation_checkpoint();
create trigger reject_factory_workflow_repository_validation_publication
  before insert on public.session_checkpoint_publications
  for each row execute function internal.reject_factory_workflow_repository_validation_checkpoint();

create function internal.factory_workflow_repository_authority_blocker(
  p_execution internal.factory_workflow_executions, p_manifest internal.factory_workflow_joins,
  p_target internal.factory_workflow_repository_delivery_targets
) returns text language plpgsql set search_path = '' as $$
declare
  writer internal.factory_workflow_repository_writers;
  connection record;
  head internal.factory_workflow_secondary_repository_heads;
begin
  if p_target.deadline_at <= clock_timestamp() then return 'deadline_expired'; end if;
  if not exists (select 1 from internal.factory_workflow_join_outcomes terminal
    where (terminal.root_session_id, terminal.join_id, terminal.outcome) = (p_manifest.root_session_id, p_manifest.join_id, 'adopted'))
    then return 'join_unavailable'; end if;
  writer := internal.resolve_factory_workflow_repository_writer(p_execution, p_manifest, p_target.repository_id);
  if (writer.grant_id, writer.grant_version) is distinct from (p_target.grant_id, p_target.grant_version)
    then return 'authority_unavailable'; end if;
  select * into connection from internal.read_factory_workflow_repository_installation(
    p_target.workspace_id, p_target.factory_id, p_target.repository_id);
  if not found or (connection.installation_id, connection.installation_numeric_id, connection.repository_numeric_id, connection.repository_full_name)
    is distinct from (p_target.installation_id, p_target.installation_numeric_id, p_target.repository_numeric_id, p_target.repository_full_name)
    then return 'authority_unavailable'; end if;
  select * into head from internal.factory_workflow_secondary_repository_heads
  where (root_session_id, parent_session_id, repository_id) =
    (p_target.root_session_id, p_target.parent_session_id, p_target.repository_id) for update;
  if not found or (head.receipt_id, head.accepted_sha, head.fetch_ref) is distinct from
    (p_target.expected_head_receipt_id, p_target.base_sha, p_target.base_fetch_ref) then return 'stale_repository_head'; end if;
  if p_target.deadline_at <= clock_timestamp() then return 'deadline_expired'; end if;
  return null;
end;
$$;
revoke all on function internal.factory_workflow_repository_authority_blocker(internal.factory_workflow_executions,
  internal.factory_workflow_joins, internal.factory_workflow_repository_delivery_targets)
  from public, anon, authenticated, service_role;

create function internal.factory_workflow_repository_delivery_fence(
  p_execution internal.factory_workflow_executions, p_manifest internal.factory_workflow_joins,
  p_target internal.factory_workflow_repository_delivery_targets, p_intent internal.factory_workflow_repository_delivery_intents
) returns text language plpgsql set search_path = '' as $$
declare blocker text;
begin
  blocker := internal.factory_workflow_repository_authority_blocker(p_execution, p_manifest, p_target);
  if blocker is not null then return blocker; end if;
  if p_intent.join_id is null or not internal.factory_workflow_repository_validation_passes(
    p_target, p_intent.validation_run_id, p_intent.candidate_sha, p_intent.tree_sha, p_manifest.required_evidence) then return 'validation_unavailable'; end if;
  return null;
end;
$$;

revoke all on function internal.factory_workflow_repository_delivery_fence(internal.factory_workflow_executions,
  internal.factory_workflow_joins, internal.factory_workflow_repository_delivery_targets, internal.factory_workflow_repository_delivery_intents)
  from public, anon, authenticated, service_role;

create function public.dispatch_next_factory_workflow_repository_validation()
returns boolean language plpgsql security definer set search_path = '' as $$
declare
  target internal.factory_workflow_repository_delivery_targets;
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  profile public.factory_definition_revisions;
  definition jsonb;
  grant_row public.factory_execution_grants;
  actor internal.session_mutation_actor;
  queued record;
  prior internal.factory_workflow_repository_validation_jobs;
  current_job public.agent_jobs;
  retirement record;
  paused_attempt boolean;
  blocked_by text;
  admission_detail text;
  candidate record;
  checked_at timestamptz := clock_timestamp();
begin
  perform internal.assert_checkpoint_publication_service();
  perform 1 from internal.git_continuity_release_control where singleton for share;
  for candidate in
    select delivery as pinned
    from internal.factory_workflow_repository_delivery_targets delivery
    join internal.factory_workflow_repository_delivery_state state using (root_session_id, join_id, repository_id)
    join internal.factory_workflow_join_outcomes terminal using (root_session_id, join_id)
    join internal.factory_workflow_executions workflow using (root_session_id)
    join public.workspaces workspace on workspace.id = delivery.workspace_id
    join public.factories factory on (factory.workspace_id, factory.id) = (delivery.workspace_id, delivery.factory_id)
    left join lateral (
      select marker.job_id from internal.factory_workflow_repository_validation_jobs marker
      where (marker.root_session_id, marker.join_id, marker.repository_id) =
        (delivery.root_session_id, delivery.join_id, delivery.repository_id)
      order by marker.admitted_generation desc limit 1
    ) latest on true
    left join public.agent_jobs job on job.id = latest.job_id
    where state.status = 'awaiting_validation' and terminal.outcome = 'adopted'
      and workflow.lifecycle_status = 'running' and workspace.deletion_requested_at is null and factory.status = 'active'
      and (latest.job_id is null or job.status in ('error', 'canceled')
        or delivery.deadline_at <= checked_at)
    order by delivery.deadline_at, delivery.root_session_id, delivery.repository_id limit 16
  loop
    target := candidate.pinned;
    perform 1 from public.workspaces workspace where workspace.id = target.workspace_id
      and workspace.deletion_requested_at is null for share skip locked;
    if not found then continue; end if;
    perform 1 from public.factories fac
    where (fac.workspace_id, fac.id, fac.status) = (target.workspace_id, target.factory_id, 'active') for share skip locked;
    if not found then continue; end if;
    perform 1 from public.sessions owner
    where (owner.id, owner.workspace_id, owner.factory_id) = (target.root_session_id, target.workspace_id, target.factory_id)
    for no key update skip locked;
    if not found then continue; end if;
    select workflow.* into execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = target.root_session_id and workflow.lifecycle_status = 'running'
    for no key update skip locked;
    if not found then continue; end if;
    perform 1 from internal.factory_workflow_repository_delivery_state state
    where (state.root_session_id, state.join_id, state.repository_id, state.status) =
      (target.root_session_id, target.join_id, target.repository_id, 'awaiting_validation') for update skip locked;
    if not found then continue; end if;
    select * into strict manifest from internal.factory_workflow_joins
    where (root_session_id, join_id) = (target.root_session_id, target.join_id);

    begin
      current_job := null;
      select marker.* into prior from internal.factory_workflow_repository_validation_jobs marker
      where (marker.root_session_id, marker.join_id, marker.repository_id) =
        (target.root_session_id, target.join_id, target.repository_id)
      order by marker.admitted_generation desc limit 1;
      if found then
        perform 1 from public.sessions subject
        where (subject.id, subject.workspace_id, subject.factory_id) =
          (prior.session_id, target.workspace_id, target.factory_id) for no key update;
        select * into strict current_job from public.agent_jobs job
        where (job.id, job.workspace_id, job.session_id) =
          (prior.job_id, target.workspace_id, prior.session_id) for update;
        if current_job.status in ('queued', 'started', 'running') and target.deadline_at > clock_timestamp()
          then continue; end if;
      end if;

      blocked_by := internal.factory_workflow_repository_authority_blocker(execution, manifest, target);
      if blocked_by = 'deadline_expired' and current_job.status in ('queued', 'started', 'running') then
        select * into strict retirement from public.cancel_session_job_attempts(prior.session_id, target.workspace_id,
          'Repository validation deadline expired.', prior.queued_run_id);
        if not prior.job_id = any(retirement.job_ids) then continue; end if;
      end if;
      if blocked_by is null and prior.job_id is not null then
        -- A canceled job can restart only when an actual workflow pause retired
        -- that precise job and attempt. Each resumed generation owns a fresh job
        -- and Git input; earlier jobs, runs, and proof remain immutable.
        select current_job.status = 'canceled' and prior.admitted_generation < execution.generation and exists (
          select 1 from internal.factory_workflow_lifecycle_commands command
          cross join lateral jsonb_array_elements(command.receipt->'retired') member
          cross join lateral jsonb_array_elements(member->'jobs') attempt
          where (command.root_session_id, command.expected_generation, command.action) =
            (target.root_session_id, prior.admitted_generation, 'pause')
            and member->>'sessionId' = prior.session_id::text
            and (attempt->>'jobId', attempt->>'attemptCount') =
              (prior.job_id::text, current_job.attempt_count::text)
        ) into paused_attempt;
        if not paused_attempt then blocked_by := 'validation_unavailable'; end if;
      end if;
      if blocked_by is null then
        select revision.* into strict profile
        from internal.factory_workflow_join_inputs input
        join internal.factory_workflow_branch_slots slot using (root_session_id, slot_id)
        join internal.factory_workflow_repository_writers writer
          on (writer.graph_revision_id, writer.repository_id) = (execution.graph_revision_id, target.repository_id)
          and slot.branch_edge_id = any(writer.branch_edge_ids)
        join internal.factory_workflow_node_occurrences occurrence
          on (occurrence.root_session_id, occurrence.occurrence_id, occurrence.node_id) =
            (manifest.root_session_id, manifest.join_occurrence_id, writer.join_node_id)
        join public.factory_definition_revisions revision
          on (revision.workspace_id, revision.factory_id, revision.id, revision.canonical_digest) =
            (target.workspace_id, target.factory_id, slot.child_definition_revision_id, slot.child_definition_digest)
        where (input.root_session_id, input.join_id) = (target.root_session_id, target.join_id)
          and input.selected and slot.required
        order by input.branch_edge_id limit 1;

        definition := profile.definition_json::jsonb;
        grant_row := internal.resolve_definition_execution_grant(target.workspace_id, target.factory_id,
          definition, target.repository_id, (definition->>'executionPolicyRevisionId')::uuid);
        if (grant_row.id, grant_row.version) is distinct from (target.grant_id, target.grant_version) then
          raise exception 'The integration profile has a different writer.' using errcode = '42501';
        end if;
        actor := row(target.workspace_id, target.factory_id, null, grant_row.service_principal_id, null,
          grant_row.id, grant_row.version, target.repository_id, null)::internal.session_mutation_actor;
        select * into strict queued from internal.create_attributed_session_from_profile(
          target.workspace_id, null, 'Workflow repository validation', 'Validate the integrated repository tree.',
          definition#>>'{agent,provider}', definition#>>'{agent,model}', null, null, target.repository_id, null, null,
          actor, (definition#>>'{implementationAgent,agentId}')::uuid, profile.canonical_digest, profile.id);
        insert into public.session_git_roots (session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
        values (queued.session_id, target.workspace_id, target.repository_id, target.repository_full_name, target.base_branch, target.base_sha);
        perform internal.prepare_session_job_git_input(queued.job_id);
        if not internal.reserve_factory_workflow_attempt(execution, queued.session_id, queued.job_id, 1) then
          raise exception 'No capacity is available for repository validation.'
            using errcode = 'PT409', detail = 'workflow_child_attempt_limit';
        end if;
        insert into internal.factory_workflow_repository_validation_jobs
          (job_id, session_id, queued_run_id, root_session_id, join_id, repository_id, admitted_generation)
        values (queued.job_id, queued.session_id, queued.run_id, target.root_session_id, target.join_id, target.repository_id, execution.generation);
        return true;
      end if;
    exception when insufficient_privilege then
      blocked_by := 'authority_unavailable';
    when sqlstate 'PT409' then
      get stacked diagnostics admission_detail = pg_exception_detail;
      if admission_detail = 'workflow_child_attempt_limit'
        and not internal.factory_workflow_branch_attempt_budget_exhausted(execution) then continue; end if;
      blocked_by := 'validation_unavailable';
    when no_data_found or sqlstate 'PT422' then
      blocked_by := 'validation_unavailable';
    when lock_not_available then
      continue;
    end;

    update internal.factory_workflow_repository_delivery_state
    set status = 'blocked', blocker = blocked_by
    where (root_session_id, join_id, repository_id) = (target.root_session_id, target.join_id, target.repository_id);
    return true;
  end loop;
  return false;
end;
$$;
revoke all on function public.dispatch_next_factory_workflow_repository_validation() from public, anon, authenticated, service_role;
grant execute on function public.dispatch_next_factory_workflow_repository_validation() to service_role;

create function internal.start_factory_workflow_repository_validation_attempt(
  p_job_id uuid, p_workspace_id uuid, p_session_id uuid, p_attempt_count integer, p_deadline_at timestamptz
) returns jsonb language plpgsql set search_path = '' as $$
declare
  marker internal.factory_workflow_repository_validation_jobs;
  target internal.factory_workflow_repository_delivery_targets;
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  subject public.sessions;
  queued public.agent_runs;
  routing jsonb;
  started uuid;
  cutoff timestamptz;
  budget_cutoff timestamptz;
  blocked_by text;
  checked_at timestamptz;
  claimed_at timestamptz;
  budget record;
begin
  select * into marker from internal.factory_workflow_repository_validation_jobs where job_id = p_job_id;
  if not found then return jsonb_build_object('kind', 'ordinary'); end if;
  select * into strict target from internal.factory_workflow_repository_delivery_targets
  where (root_session_id, join_id, repository_id) = (marker.root_session_id, marker.join_id, marker.repository_id);
  if marker.session_id is distinct from p_session_id or target.workspace_id is distinct from p_workspace_id
    or p_deadline_at is null or not isfinite(p_deadline_at) or p_attempt_count is null or p_attempt_count < 1 then
    return jsonb_build_object('kind', 'retired');
  end if;

  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(marker.root_session_id, p_workspace_id, target.factory_id);
  select * into strict execution from internal.factory_workflow_executions
  where root_session_id = marker.root_session_id for no key update;
  if execution.lifecycle_status <> 'running' or execution.generation <> marker.admitted_generation then
    return jsonb_build_object('kind', 'retired');
  end if;
  select * into strict manifest from internal.factory_workflow_joins where (root_session_id, join_id) = (marker.root_session_id, marker.join_id);
  if exists (select 1 from internal.factory_workflow_repository_validation_attempts bound
    where bound.validation_job_id = p_job_id and bound.attempt_count = p_attempt_count) then
    return jsonb_build_object('kind', 'started_elsewhere');
  end if;
  if internal.git_continuity_effective_attempt_count(p_job_id, p_workspace_id, p_session_id, p_attempt_count) <> 1 then
    return jsonb_build_object('kind', 'retired');
  end if;
  blocked_by := internal.factory_workflow_repository_authority_blocker(execution, manifest, target);
  if blocked_by is not null then
    perform public.cancel_session_job_attempts(p_session_id, p_workspace_id, 'Repository validation authority is unavailable.',
      marker.queued_run_id);
    update internal.factory_workflow_repository_delivery_state set status = 'blocked', blocker = blocked_by
    where (root_session_id, join_id, repository_id, status) =
      (marker.root_session_id, marker.join_id, marker.repository_id, 'awaiting_validation');
    return jsonb_build_object('kind', 'retired');
  end if;

  select * into strict subject from public.sessions where (id, workspace_id, factory_id) =
    (p_session_id, p_workspace_id, target.factory_id) for no key update;
  perform internal.recheck_session_execution_grant(subject);
  if p_deadline_at <= clock_timestamp() then return jsonb_build_object('kind', 'retired'); end if;
  select job.started_at into claimed_at from public.agent_jobs job
  where (job.id, job.workspace_id, job.session_id, job.attempt_count) = (p_job_id, p_workspace_id, p_session_id, p_attempt_count)
    and job.status in ('started', 'running') for update;
  if not found then return jsonb_build_object('kind', 'retired'); end if;
  select * into strict queued from public.agent_runs where id = marker.queued_run_id;
  routing := internal.effective_factory_routing_execution(p_workspace_id, target.factory_id, p_session_id);
  started := internal.start_session_job_attempt(p_job_id, p_attempt_count, subject.current_stage_id, subject.current_artifact_version,
    coalesce(routing#>>'{configuration,harness}', queued.model_provider), coalesce(routing->>'modelName', queued.model_name),
    'code', 'wallie/join/' || marker.join_id::text);
  if started is null then return jsonb_build_object('kind', 'retired'); end if;
  if started <> marker.queued_run_id then raise exception 'Repository validation did not start the admitted run.' using errcode = 'PT409'; end if;
  perform public.pin_session_job_git_input(p_job_id, p_attempt_count, started, target.repository_id, target.base_branch, target.base_sha);
  if not found then raise exception 'Repository validation could not pin its exact Git input.' using errcode = 'PT409'; end if;
  checked_at := clock_timestamp();
  select * into budget from public.get_session_execution_budget(subject.id);
  if not found or budget.exhaustion_code is not null then
    raise exception 'Repository validation execution budget is exhausted.' using errcode = 'PT409';
  end if;
  budget_cutoff := checked_at + budget.remaining_execution_ms * interval '1 millisecond';
  cutoff := least(target.deadline_at, p_deadline_at, coalesce(claimed_at, checked_at) + interval '30 minutes',
    (select dispatch.deadline_at from public.worker_dispatches dispatch
      where (dispatch.job_id, dispatch.attempt_count, dispatch.workspace_id) = (p_job_id, p_attempt_count, p_workspace_id)),
    budget_cutoff);
  if cutoff <= clock_timestamp() then
    raise exception 'Repository validation could not pin its exact attempt.' using errcode = 'PT409';
  end if;
  insert into internal.factory_workflow_repository_validation_attempts
    (root_session_id, join_id, repository_id, validation_session_id, validation_job_id, validation_run_id,
      attempt_count, generation, deadline_at)
  values (marker.root_session_id, marker.join_id, marker.repository_id, p_session_id, p_job_id, started,
    p_attempt_count, execution.generation, cutoff);
  return jsonb_build_object('kind', 'repository', 'rootSessionId', marker.root_session_id, 'workspaceId', p_workspace_id,
    'factoryId', target.factory_id, 'parentSessionId', p_session_id, 'repositoryId', target.repository_id,
    'joinId', marker.join_id, 'jobId', p_job_id, 'runId', started, 'attemptCount', p_attempt_count, 'generation', execution.generation,
    'ownershipToken', execution.ownership_token, 'artifactVersion', subject.current_artifact_version, 'baseSha', target.base_sha,
    'baseRef', target.base_fetch_ref, 'baseReceiptId', target.expected_head_receipt_id, 'deadlineAt', cutoff, 'deadlineReason', case when budget_cutoff = cutoff then 'elapsed_execution' else 'worker' end);
end;
$$;
revoke all on function internal.start_factory_workflow_repository_validation_attempt(uuid, uuid, uuid, integer, timestamptz)
  from public, anon, authenticated, service_role;

create function internal.lock_factory_workflow_repository_validation_attempt(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns boolean language plpgsql set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  target internal.factory_workflow_repository_delivery_targets;
  attempt internal.factory_workflow_repository_validation_attempts;
begin
  execution := internal.lock_factory_workflow_owner(p_root_session_id, p_workspace_id, p_factory_id, p_generation, p_owner);
  select * into target from internal.factory_workflow_repository_delivery_targets
  where (root_session_id, join_id, repository_id) = (p_root_session_id, p_join_id, p_repository_id);
  if not found then return false; end if;
  select * into strict manifest from internal.factory_workflow_joins
  where (root_session_id, join_id) = (target.root_session_id, target.join_id);
  if internal.factory_workflow_repository_authority_blocker(execution, manifest, target) is not null then return false; end if;
  select * into attempt from internal.factory_workflow_repository_validation_attempts
  where (root_session_id, join_id, repository_id, validation_job_id, validation_run_id, attempt_count, generation) =
    (p_root_session_id, p_join_id, p_repository_id, p_job_id, p_run_id, p_attempt_count, p_generation);
  if not found then return false; end if;
  perform 1 from public.sessions subject where (subject.id, subject.workspace_id, subject.factory_id) =
    (attempt.validation_session_id, p_workspace_id, p_factory_id) and subject.archived_at is null for no key update;
  if not found then return false; end if;
  perform 1 from public.agent_jobs job
  where (job.id, job.workspace_id, job.session_id, job.attempt_count) =
    (p_job_id, p_workspace_id, attempt.validation_session_id, p_attempt_count)
    and job.status in ('started', 'running') for update;
  if not found then return false; end if;
  perform 1 from public.agent_runs run
  where (run.id, run.agent_job_id, run.workspace_id, run.session_id, run.attempt_count) =
    (p_run_id, p_job_id, p_workspace_id, attempt.validation_session_id, p_attempt_count)
    and run.status in ('started', 'running') for update;
  return found and attempt.deadline_at > clock_timestamp() and target.deadline_at > clock_timestamp();
end;
$$;
revoke all on function internal.lock_factory_workflow_repository_validation_attempt(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid, integer)
  from public, anon, authenticated, service_role;

create function public.is_factory_workflow_repository_validation_active(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  return internal.lock_factory_workflow_repository_validation_attempt(
    p_root_session_id, p_workspace_id, p_factory_id, p_generation, p_owner, p_join_id, p_repository_id, p_job_id, p_run_id, p_attempt_count);
end;
$$;

create function public.finish_factory_workflow_repository_validation(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid, p_generation bigint, p_owner uuid,
  p_join_id uuid, p_repository_id uuid, p_job_id uuid, p_run_id uuid, p_attempt_count integer,
  p_result text, p_candidate_sha text default null, p_tree_sha text default null, p_bundle_sha256 text default null,
  p_bundle_base64 text default null
) returns boolean language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if p_result not in ('passed', 'validation_failed', 'merge_conflict') or p_result is null then return false; end if;
  if not internal.lock_factory_workflow_repository_validation_attempt(
    p_root_session_id, p_workspace_id, p_factory_id, p_generation, p_owner, p_join_id, p_repository_id, p_job_id, p_run_id, p_attempt_count)
  then return false; end if;
  if p_result = 'passed' then
    if not internal.seal_factory_workflow_repository_delivery(p_root_session_id, p_workspace_id, p_factory_id,
      p_generation, p_owner, p_join_id, p_repository_id, p_run_id, p_candidate_sha, p_tree_sha, p_bundle_sha256, p_bundle_base64)
      then return false; end if;
    update public.agent_runs set status = 'success', finished_at = clock_timestamp() where id = p_run_id;
    if not public.complete_session_job_attempt(p_job_id, p_attempt_count, p_run_id) then
      raise exception 'Repository validation lost its exact attempt.' using errcode = 'PT409';
    end if;
    update public.sessions set phase_status = 'approved', archived_at = clock_timestamp()
    where id = (select session_id from public.agent_runs where id = p_run_id);
  else
    update internal.factory_workflow_repository_delivery_state set status = 'blocked', blocker = p_result
    where (root_session_id, join_id, repository_id, status) = (p_root_session_id, p_join_id, p_repository_id, 'awaiting_validation');
    if not found then return false; end if;
    if public.fail_session_job_attempt(p_job_id, p_attempt_count, 'Repository validation did not pass.', false, 0, p_run_id) <> 'error'
      then raise exception 'Repository validation lost its exact attempt.' using errcode = 'PT409'; end if;
  end if;
  return true;
end;
$$;
revoke all on function public.is_factory_workflow_repository_validation_active(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid, integer),
  public.finish_factory_workflow_repository_validation(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.is_factory_workflow_repository_validation_active(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid, integer),
  public.finish_factory_workflow_repository_validation(uuid, uuid, uuid, bigint, uuid, uuid, uuid, uuid, uuid, integer, text, text, text, text, text)
  to service_role;

create or replace function public.start_factory_workflow_join_attempt(
  p_job_id uuid,p_workspace_id uuid,p_session_id uuid,p_attempt_count integer,p_deadline_at timestamptz
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  marker internal.factory_workflow_join_jobs;
  execution internal.factory_workflow_executions;
  manifest internal.factory_workflow_joins;
  parent public.sessions;
  captured public.agent_jobs;
  validation_input public.session_job_git_inputs;
  branch text;
  routing jsonb;
  provider text;
  model text;
  started uuid;
  deadline_at timestamptz;
  deadline_reason text;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into marker from internal.factory_workflow_join_jobs where job_id=p_job_id;
  if not found then return internal.start_factory_workflow_repository_validation_attempt(
    p_job_id, p_workspace_id, p_session_id, p_attempt_count, p_deadline_at); end if;
  if (marker.workspace_id,marker.parent_session_id) is distinct from (p_workspace_id,p_session_id)
    or p_attempt_count is null or p_attempt_count<=0 or p_deadline_at is null or not isfinite(p_deadline_at)
    then return jsonb_build_object('kind','retired'); end if;

  -- Match the existing queue and start path's release -> workspace -> root
  -- locking order. The exact owner can be returned only to the claimed worker.
  perform 1 from internal.git_continuity_release_control where singleton for share;
  perform internal.lock_factory_workflow_root(marker.root_session_id,p_workspace_id,marker.factory_id);
  select * into execution from internal.factory_workflow_executions where root_session_id=marker.root_session_id for no key update;
  if not found or execution.lifecycle_status<>'running' or execution.generation<>marker.expected_generation
    then return jsonb_build_object('kind','retired'); end if;
  select * into strict manifest from internal.factory_workflow_joins where (root_session_id,join_id)=(marker.root_session_id,marker.join_id);
  if not internal.factory_workflow_join_head_is_current(manifest)
    or not internal.recheck_factory_workflow_delegation_lineage(marker.root_session_id,p_workspace_id,marker.factory_id,p_session_id)
    then return jsonb_build_object('kind','retired'); end if;
  select * into parent from public.sessions where (id,workspace_id,factory_id)=(p_session_id,p_workspace_id,marker.factory_id) for no key update;
  if not found or (parent.current_stage_id,parent.current_artifact_id,parent.current_artifact_version)
    is distinct from (marker.stage_id,marker.artifact_id,marker.artifact_version)
    then return jsonb_build_object('kind','retired'); end if;
  select * into captured from public.agent_jobs where (id,workspace_id,session_id,stage_id,attempt_count)
    =(p_job_id,p_workspace_id,p_session_id,marker.stage_id,p_attempt_count) and status in ('started','running') for update;
  if not found or internal.git_continuity_effective_attempt_count(p_job_id,p_workspace_id,p_session_id,p_attempt_count)<>1
    then return jsonb_build_object('kind','retired'); end if;
  if exists(select 1 from internal.factory_workflow_join_attempts bound
    where (bound.root_session_id,bound.join_id,bound.job_id,bound.attempt_count)=(marker.root_session_id,marker.join_id,p_job_id,p_attempt_count))
    then return jsonb_build_object('kind','started_elsewhere'); end if;

  select * into strict validation_input from public.session_job_git_inputs where job_id=p_job_id;
  if (validation_input.source_checkpoint_run_id,validation_input.repository_id,validation_input.input_sha)
    is distinct from (manifest.expected_head_run_id,manifest.repository_id,manifest.base_sha)
    then return jsonb_build_object('kind','retired'); end if;
  if p_deadline_at <= clock_timestamp() then return jsonb_build_object('kind','retired'); end if;
  routing:=internal.effective_factory_routing_execution(p_workspace_id,marker.factory_id,p_session_id);
  select model_provider,model_name into strict provider,model from public.agent_runs
  where agent_job_id=p_job_id and status='queued' and attempt_count is null;
  provider:=coalesce(routing#>>'{configuration,harness}',provider);
  model:=coalesce(routing->>'modelName',model);
  branch:='wallie/join/'||marker.join_id::text;

  started:=internal.start_session_job_attempt(p_job_id,p_attempt_count,marker.stage_id,marker.artifact_version,provider,model,'code',branch);
  if started is null then return jsonb_build_object('kind','retired'); end if;
  if started<>marker.queued_run_id then
    raise exception 'The workflow join did not start the admitted run.' using errcode='PT409';
  end if;
  perform public.pin_session_job_git_input(p_job_id,p_attempt_count,started,manifest.repository_id,validation_input.base_branch,manifest.base_sha);
  if not found or not internal.bind_factory_workflow_join_attempt(marker.root_session_id,p_workspace_id,marker.factory_id,
    execution.generation,execution.ownership_token,marker.join_id,p_job_id,p_attempt_count,started,p_deadline_at)
    then raise exception 'The workflow join attempt could not bind its exact input and deadline.' using errcode='PT409'; end if;
  select bound.deadline_at,bound.deadline_reason into strict deadline_at,deadline_reason
  from internal.factory_workflow_join_attempts bound where bound.run_id=started;
  if clock_timestamp() >= deadline_at then
    raise exception 'Workflow join attempt deadline elapsed before start.' using errcode='57014';
  end if;
  return jsonb_build_object('kind','started','rootSessionId',marker.root_session_id,'workspaceId',p_workspace_id,
    'factoryId',marker.factory_id,'parentSessionId',p_session_id,'joinId',marker.join_id,'jobId',p_job_id,'runId',started,
    'attemptCount',p_attempt_count,'generation',execution.generation,'ownershipToken',execution.ownership_token,
    'artifactVersion',marker.artifact_version,'baseSha',manifest.base_sha,'baseRef',validation_input.input_ref,
    'deadlineAt',deadline_at,'deadlineReason',deadline_reason);
end;
$$;

create or replace function public.fail_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_error text,p_retry boolean,p_max_retries integer,p_run_id uuid default null
) returns text language plpgsql security invoker set search_path='' as $$
declare typed boolean; outcome text;
begin
  perform internal.assert_checkpoint_publication_service();
  typed:=internal.is_factory_workflow_join_job(p_job_id);
  outcome:=internal.fail_session_job_attempt_before_workflow_join(p_job_id,p_attempt_count,p_error,
    p_retry and not typed and not internal.is_factory_workflow_repository_validation_job(p_job_id),p_max_retries,p_run_id);
  if typed and outcome='error' then
    perform internal.park_factory_workflow_join_review(array[p_job_id]);
  end if;
  return outcome;
end;
$$;

create function public.list_factory_workflow_repository_deliveries()
returns table(root_session_id uuid, workspace_id uuid, factory_id uuid, join_id uuid, repository_id uuid,
  generation bigint, ownership_token uuid)
language sql stable security definer set search_path = '' as $$
  select target.root_session_id, target.workspace_id, target.factory_id, target.join_id, target.repository_id,
    execution.generation, execution.ownership_token
  from internal.factory_workflow_repository_delivery_state state
  join internal.factory_workflow_repository_delivery_targets target using (root_session_id, join_id, repository_id)
  join internal.factory_workflow_executions execution on execution.root_session_id = state.root_session_id
  join internal.factory_workflow_join_outcomes terminal
    on (terminal.root_session_id, terminal.join_id) = (state.root_session_id, state.join_id)
  join public.workspaces workspace on workspace.id = target.workspace_id
  join public.factories factory on (factory.workspace_id, factory.id) = (target.workspace_id, target.factory_id)
  where terminal.outcome = 'adopted' and execution.lifecycle_status = 'running'
    and workspace.deletion_requested_at is null and factory.status = 'active'
    and (state.status = 'pending' and state.next_attempt_at <= statement_timestamp()
      or state.status = 'claimed' and (state.claim_until <= statement_timestamp() or state.claim_generation <> execution.generation))
  order by state.next_attempt_at, target.root_session_id, target.repository_id
  limit 8
$$;
revoke all on function public.list_factory_workflow_repository_deliveries() from public, anon, authenticated, service_role;
grant execute on function public.list_factory_workflow_repository_deliveries() to service_role;

create or replace function internal.find_factory_workflow_lifecycle_root(p_session_id uuid)
returns uuid language sql stable set search_path = '' as $$
  select execution.root_session_id
  from internal.factory_workflow_executions execution
  where execution.root_session_id = coalesce(
    (select marker.root_session_id from internal.factory_workflow_delegations marker where marker.child_session_id = p_session_id),
    (select marker.root_session_id from internal.factory_workflow_repository_validation_jobs marker where marker.session_id = p_session_id),
    p_session_id
  ) and execution.graph_revision_id is not null
$$;

create or replace function internal.start_session_job_attempt(
  p_job_id uuid,p_attempt_count integer,p_expected_stage_id uuid,p_expected_artifact_version integer,
  p_model_provider text,p_model_name text,p_run_type text,p_branch_name text default null
) returns uuid language plpgsql security definer set search_path='' as $$
declare control internal.git_continuity_release_control; job public.agent_jobs; session public.sessions; execution_id uuid; routing jsonb;
  workflow_root_id uuid;
  budget_root_id uuid;
  budget_parent_id uuid;
  budget_execution internal.factory_workflow_executions;
  budget_root public.sessions;
begin
  perform internal.assert_checkpoint_publication_service();
  select * into strict control from internal.git_continuity_release_control where singleton for share;
  select * into job from public.agent_jobs where id=p_job_id;
  if not found or p_attempt_count is null or p_attempt_count<=0 or job.attempt_count<>p_attempt_count
    or job.status not in('started','running') then return null; end if;
  select * into session from public.sessions where id=job.session_id and workspace_id=job.workspace_id;
  if not found then return null; end if;
  if session.pipeline_id is not null and (not control.enabled or job.git_continuity_release_revision is distinct from control.revision
    or not exists(select 1 from public.session_git_continuity_enrollments e where e.session_id=session.id and e.workspace_id=session.workspace_id)) then
    raise exception 'Git continuity admission is paused or requires a fresh session.' using errcode='P499P';
  end if;
  perform 1 from public.workspaces where id=job.workspace_id for share;
  if not found then return null; end if;
  perform internal.assert_workspace_accepts_work(job.workspace_id);
  workflow_root_id := internal.find_factory_workflow_lifecycle_root(session.id);
  if workflow_root_id is not null then
    perform internal.lock_factory_workflow_root(workflow_root_id, session.workspace_id, session.factory_id);
    select workflow.* into budget_execution from internal.factory_workflow_executions workflow
    where workflow.root_session_id = workflow_root_id for no key update;
    if not found or budget_execution.lifecycle_status <> 'running' then return null; end if;
    if budget_execution.workflow_json::jsonb ? 'delegationPolicy' then budget_root_id := workflow_root_id; end if;
  end if;
  if budget_root_id is not null then
    select * into strict budget_root from public.sessions where id = budget_root_id;
    if budget_root.archived_at is not null and budget_root.phase_status <> 'approved' then return null; end if;
    if budget_root.id = session.id then
      perform internal.recheck_session_execution_grant(budget_root);
    else
      select origin.parent_session_id into budget_parent_id
      from (
        select marker.parent_session_id from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id) =
          (budget_root_id, session.workspace_id, session.factory_id, session.id)
        union all
        select target.parent_session_id from internal.factory_workflow_repository_validation_jobs integration
        join internal.factory_workflow_repository_delivery_targets target using (root_session_id, join_id, repository_id)
        where (integration.root_session_id, target.workspace_id, target.factory_id, integration.session_id, integration.job_id) =
          (budget_root_id, session.workspace_id, session.factory_id, session.id, p_job_id)
      ) origin;
      if not found or not internal.recheck_factory_workflow_delegation_lineage(
        budget_root_id, session.workspace_id, session.factory_id, budget_parent_id
      ) then return null; end if;
    end if;
    if not internal.reserve_factory_workflow_attempt(
      budget_execution, session.id, p_job_id, p_attempt_count
    ) then return null; end if;
  end if;
  select owner.* into session from public.sessions owner
  where (owner.id, owner.workspace_id) = (job.session_id, job.workspace_id) for no key update;
  if not found then return null; end if;
  if session.execution_purpose = 'production' and session.execute_pinned_definition then
    routing := internal.effective_factory_routing_execution(session.workspace_id, session.factory_id, session.id);
    if routing is not null and (job.claimed_worker_runtime, p_model_provider, p_model_name) is distinct from
      (routing#>>'{configuration,workerRuntime}', routing#>>'{configuration,harness}', routing->>'modelName') then
      raise exception 'The claimed attempt does not match the pinned routing configuration.' using errcode = '23514';
    end if;
  end if;
  perform internal.recheck_session_execution_grant(session);
  if not internal.session_execution_admissible(session.id,session.workspace_id) then return null; end if;
  execution_id:=internal.start_session_job_attempt_before_release(p_job_id,p_attempt_count,p_expected_stage_id,p_expected_artifact_version,
    p_model_provider,p_model_name,p_run_type,p_branch_name);
  if execution_id is not null then
    if budget_root_id is not null and not internal.bind_factory_workflow_attempt(
      budget_root_id, p_job_id, p_attempt_count, execution_id
    ) then
      raise exception 'The workflow attempt reservation is unavailable.' using errcode = 'PT409';
    end if;
    perform internal.bind_manual_retry_feedback(p_job_id);
  end if;
  return execution_id;
end;
$$;

create or replace function public.control_factory_workflow_lifecycle(
  p_root_session_id uuid, p_workspace_id uuid, p_factory_id uuid,
  p_expected_generation bigint, p_request_id uuid, p_action text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  execution internal.factory_workflow_executions;
  prior internal.factory_workflow_lifecycle_commands;
  owner public.sessions;
  parent_id uuid;
  member_ids uuid[];
  prior_state text;
  next_state text;
  pause_receipt jsonb;
  retired jsonb := '[]'::jsonb;
  resumed jsonb := '[]'::jsonb;
  retirement record;
  restart record;
  resume_input jsonb;
  receipt jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  if p_request_id is null or coalesce(p_action, '') not in ('pause', 'resume', 'cancel')
    or p_expected_generation is null or p_expected_generation not between 1 and 9007199254740990 then
    raise exception 'Invalid workflow lifecycle command.' using errcode = '22023';
  end if;

  perform internal.lock_factory_workflow_root(p_root_session_id, p_workspace_id, p_factory_id);
  select workflow.* into execution from internal.factory_workflow_executions workflow
  where (workflow.root_session_id, workflow.workspace_id, workflow.factory_id) =
    (p_root_session_id, p_workspace_id, p_factory_id) and workflow.graph_revision_id is not null
  for no key update;
  if not found then raise exception 'Workflow graph is unavailable.' using errcode = 'PT404'; end if;
  select command.* into prior from internal.factory_workflow_lifecycle_commands command
  where (command.root_session_id, command.request_id) = (p_root_session_id, p_request_id);
  if found then
    if (prior.expected_generation, prior.action) is distinct from (p_expected_generation, p_action) then
      raise exception 'The workflow request was already used with different intent.' using errcode = 'PT409';
    end if;
    return prior.receipt;
  end if;
  if execution.generation is distinct from p_expected_generation then
    raise exception 'Workflow generation is stale.' using errcode = 'PT409';
  end if;
  prior_state := execution.lifecycle_status;
  if prior_state = 'canceled' or (p_action = 'pause' and prior_state <> 'running')
    or (p_action = 'resume' and prior_state <> 'paused') then
    raise exception 'The workflow lifecycle transition is unavailable.' using errcode = 'PT409';
  end if;
  next_state := case p_action when 'pause' then 'paused' when 'resume' then 'running' else 'canceled' end;

  select array_prepend(p_root_session_id, coalesce(array_agg(member.session_id order by member.session_id), '{}'::uuid[]))
  into member_ids from (
    select marker.child_session_id as session_id from internal.factory_workflow_delegations marker
    where (marker.root_session_id, marker.workspace_id, marker.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
    union all
    select validation.session_id from internal.factory_workflow_repository_validation_jobs validation
    join internal.factory_workflow_repository_delivery_targets target using (root_session_id, join_id, repository_id)
    where (validation.root_session_id, target.workspace_id, target.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
  ) member;
  perform 1 from public.sessions session
  where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id) and session.id = any(member_ids)
  order by session.id <> p_root_session_id, session.id for no key update;

  if p_action = 'resume' then
    select root.* into owner from public.sessions root
    join public.session_factory_admission_inputs pin
      on (pin.session_id, pin.workspace_id, pin.factory_id, pin.definition_revision_id) =
        (root.id, root.workspace_id, root.factory_id, root.factory_definition_revision_id)
    where (root.id, root.workspace_id, root.factory_id) = (p_root_session_id, p_workspace_id, p_factory_id)
      and (pin.definition_revision_id, pin.definition_digest) =
        (execution.definition_revision_id, execution.definition_digest)
      and root.execute_pinned_definition and (root.archived_at is null or root.phase_status = 'approved')
      and root.execution_policy_revision_id is not distinct from pin.execution_policy_revision_id;
    if not found then
      raise exception 'The workflow root cannot resume its pinned execution.' using errcode = 'PT409';
    end if;
    perform internal.recheck_session_execution_grant(owner);
    if not internal.session_execution_admissible(owner.id, owner.workspace_id) then
      raise exception 'The workflow root execution budget is exhausted.' using errcode = 'PT409';
    end if;

    select command.receipt into strict pause_receipt from internal.factory_workflow_lifecycle_commands command
    where (command.root_session_id, command.applied_generation, command.action) =
      (p_root_session_id, p_expected_generation, 'pause');
  end if;

  update internal.factory_workflow_executions workflow
  set lifecycle_status = next_state, generation = workflow.generation + 1, ownership_token = gen_random_uuid()
  where workflow.root_session_id = p_root_session_id returning * into execution;

  if p_action = 'resume' then
    for resume_input in select value from jsonb_array_elements(pause_receipt->'retired')
      where value->'restartRequired' = 'true'::jsonb
    loop
      select session.* into owner from public.sessions session
      where (session.id::text, session.workspace_id, session.factory_id, session.current_stage_id::text,
        session.current_artifact_version) = (resume_input->>'sessionId', p_workspace_id, p_factory_id,
        resume_input->>'stageId', (resume_input->>'artifactVersion')::integer)
        and session.id = any(member_ids) and session.archived_at is null
        and session.current_artifact_id::text is not distinct from resume_input->>'artifactId'
        and session.phase_status in ('in_progress', 'rejected', 'awaiting_review');
      if not found or not internal.session_execution_admissible(owner.id, owner.workspace_id) then continue; end if;

      if owner.id <> p_root_session_id then
        select marker.parent_session_id into parent_id from internal.factory_workflow_delegations marker
        where (marker.root_session_id, marker.workspace_id, marker.factory_id, marker.child_session_id) =
          (p_root_session_id, p_workspace_id, p_factory_id, owner.id);
        if not found or not internal.recheck_factory_workflow_delegation_lineage(
          p_root_session_id, p_workspace_id, p_factory_id, parent_id
        ) then continue; end if;
      end if;
      perform internal.recheck_session_execution_grant(owner);

      -- The job already owns the exact feedback, retry origin, and Git
      -- input. The queue assigns a fresh attempt and run on its next claim.
      update public.agent_jobs job
      set status = 'queued', finished_at = null, scheduled_at = null, started_at = null, last_error = null,
        claimed_worker_runtime = null, git_continuity_release_revision = null
      where (job.id::text, job.workspace_id, job.session_id, job.stage_id, job.attempt_count) =
        (resume_input#>>'{jobs,0,jobId}', owner.workspace_id, owner.id, owner.current_stage_id,
          (resume_input#>>'{jobs,0,attemptCount}')::integer)
        and job.status = 'canceled'
      returning job.id, job.attempt_count + 1 as next_attempt into restart;
      if found then
        if execution.workflow_json::jsonb ? 'delegationPolicy'
          and not internal.reserve_factory_workflow_attempt(execution, owner.id, restart.id, restart.next_attempt) then
          raise exception 'The workflow budget cannot restart the paused attempt.' using errcode = 'PT409';
        end if;
        resumed := resumed || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobId', restart.id, 'attemptCount', restart.next_attempt));
      end if;
    end loop;
  else
    for owner in select session.* from public.sessions session
      where (session.workspace_id, session.factory_id) = (p_workspace_id, p_factory_id)
        and session.id = any(member_ids)
        and exists (select 1 from public.agent_jobs job
          where (job.session_id, job.workspace_id) = (session.id, session.workspace_id)
            and (job.status in ('started', 'running') or (job.status = 'queued' and (
              p_action = 'cancel' or internal.is_factory_workflow_join_job(job.id)
              or internal.is_factory_workflow_repository_validation_job(job.id)))))
      order by session.id <> p_root_session_id, session.id
    loop
      select * into strict retirement from public.cancel_session_job_attempts(owner.id, owner.workspace_id,
        case p_action when 'pause' then 'Workflow paused.' else 'Workflow canceled.' end,
        null, p_action = 'cancel');
      if cardinality(retirement.job_ids) > 0 then
        perform internal.park_factory_workflow_join_review(retirement.job_ids);
        retired := retired || jsonb_build_array(jsonb_build_object(
          'sessionId', owner.id, 'jobIds', retirement.job_ids, 'runIds', retirement.run_ids,
          'jobs', (select jsonb_agg(jsonb_build_object('jobId', job.id, 'attemptCount', job.attempt_count) order by job.id)
            from public.agent_jobs job where job.id = any(retirement.job_ids)),
          'stageId', owner.current_stage_id, 'artifactId', owner.current_artifact_id,
          'artifactVersion', owner.current_artifact_version,
          'restartRequired', p_action = 'pause' and owner.archived_at is null
            and not exists (select 1 from unnest(retirement.job_ids) exact(id)
              where internal.is_factory_workflow_join_job(exact.id) or internal.is_factory_workflow_repository_validation_job(exact.id))
            and owner.phase_status in ('in_progress', 'rejected', 'awaiting_review')
            and not exists (select 1 from public.agent_runs run
              where run.id = any(retirement.run_ids) and run.status = 'success')
        ));
      end if;
    end loop;
  end if;

  receipt := jsonb_build_object('requestId', p_request_id, 'action', p_action,
    'generation', execution.generation, 'lifecycleStatus', execution.lifecycle_status, 'retired', retired, 'resumed', resumed);
  insert into internal.factory_workflow_lifecycle_commands(root_session_id, request_id, expected_generation, action, applied_generation, receipt)
  values (p_root_session_id, p_request_id, p_expected_generation, p_action, execution.generation, receipt);
  return receipt;
end;
$$;

create or replace function internal.factory_workflow_root_join_keeps_scope(
  p_binding internal.factory_workflow_triage_bindings, p_saved internal.factory_workflow_accepted_scopes
) returns boolean language plpgsql set search_path = '' as $$
declare
  current_run_id uuid;
  accepted public.session_git_checkpoints;
begin
  if (p_binding.session_id, p_binding.workspace_id, p_binding.factory_id,
    p_binding.graph_revision_id, p_binding.workflow_digest, p_binding.stage_id, p_binding.prompt_revision_id)
    is distinct from (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id,
      p_saved.graph_revision_id, p_saved.workflow_digest, p_saved.stage_id, p_saved.prompt_revision_id)
    then return false; end if;
  select head.checkpoint_run_id into current_run_id
  from internal.factory_workflow_executions execution
  join public.sessions root on (root.id, root.workspace_id, root.factory_id) =
    (execution.root_session_id, execution.workspace_id, execution.factory_id)
  join public.session_git_heads head on (head.session_id, head.workspace_id) = (root.id, root.workspace_id)
  where (execution.root_session_id, execution.workspace_id, execution.factory_id, execution.graph_revision_id,
    execution.workflow_digest, execution.graph_input_run_id) = (p_saved.session_id, p_saved.workspace_id,
    p_saved.factory_id, p_saved.graph_revision_id, p_saved.workflow_digest, p_saved.run_id)
    and (root.factory_definition_revision_id, root.specification_stage_id, root.current_stage_id) =
      (p_binding.definition_revision_id, p_saved.stage_id, p_saved.stage_id)
    and root.execute_pinned_definition and root.execution_purpose = 'production'
    and root.phase_status in ('in_progress', 'awaiting_review', 'approved')
    and (root.archived_at is null or root.phase_status = 'approved')
    and head.checkpoint_run_id <> p_saved.run_id
    and not exists (select 1 from public.session_specification_clarifications clarification
      where (clarification.session_id, clarification.workspace_id, clarification.factory_id, clarification.stage_id) =
        (p_saved.session_id, p_saved.workspace_id, p_saved.factory_id, p_saved.stage_id)
        and clarification.status = 'pending')
    and not exists (select 1 from public.artifact_review_threads thread
      where (thread.session_id, thread.workspace_id) = (p_saved.session_id, p_saved.workspace_id)
        and thread.kind = 'blocking' and thread.status = 'open')
  for share of head;
  if not found then return false; end if;
  accepted := internal.factory_workflow_adopted_checkpoint(p_saved.session_id, p_saved.workspace_id,
    p_saved.factory_id, p_binding.definition_revision_id, p_binding.definition_digest, current_run_id);
  if accepted.run_id is null or accepted.repository_id is distinct from p_saved.repository_id then return false; end if;

  return exists (
    with recursive lineage(run_id, depth) as (
      select current_run_id, 0
      union all
      select manifest.expected_head_run_id, lineage.depth + 1
      from lineage
      join internal.factory_workflow_join_outcomes terminal on (terminal.root_session_id, terminal.checkpoint_run_id) =
        (p_saved.session_id, lineage.run_id) and terminal.outcome = 'adopted'
      join internal.factory_workflow_joins manifest using (root_session_id, join_id)
      where (exists (
        select 1 from internal.factory_workflow_node_results result
        where (result.root_session_id, result.occurrence_id, result.outcome, result.evidence_ref) =
          (manifest.root_session_id, manifest.join_occurrence_id, 'succeeded', 'join-checkpoint:' || lineage.run_id)
      ) or exists (
        select 1 from internal.factory_workflow_repository_delivery_targets delivery
        where (delivery.root_session_id, delivery.join_id) = (manifest.root_session_id, manifest.join_id)
      )) and (manifest.workspace_id, manifest.factory_id, manifest.parent_session_id,
        manifest.workflow_digest, manifest.repository_id) =
        (p_saved.workspace_id, p_saved.factory_id, p_saved.session_id, p_saved.workflow_digest, p_saved.repository_id)
        and lineage.depth < 1023 and lineage.run_id <> p_saved.run_id
    )
    select 1 from lineage where lineage.run_id = p_saved.run_id
  );
end;
$$;

create function internal.block_factory_workflow_repository_delivery_on_primary_failure()
returns trigger language plpgsql set search_path = '' as $$
begin
  update internal.factory_workflow_repository_delivery_state
  set status = 'blocked', blocker = 'join_unavailable'
  where (root_session_id, join_id, status) = (new.root_session_id, new.join_id, 'awaiting_validation');
  return new;
end;
$$;
revoke all on function internal.block_factory_workflow_repository_delivery_on_primary_failure()
  from public, anon, authenticated, service_role;
create trigger block_factory_workflow_repository_delivery_on_primary_failure
  after insert on internal.factory_workflow_join_outcomes for each row
  when (new.outcome <> 'adopted') execute function internal.block_factory_workflow_repository_delivery_on_primary_failure();
