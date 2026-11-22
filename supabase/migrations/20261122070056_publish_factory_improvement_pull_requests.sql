create table internal.factory_improvement_publication_targets (
  workspace_id uuid not null,
  factory_id uuid not null,
  id uuid not null default gen_random_uuid(),
  repository_id uuid not null,
  base_branch text not null,
  primary key (workspace_id, factory_id),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table internal.factory_improvement_publications (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  proposal_id uuid not null,
  proposal_revision_id uuid not null,
  validation_id uuid not null references internal.factory_improvement_validations(id) deferrable initially deferred,
  author_member_id uuid not null,
  target jsonb not null check (jsonb_typeof(target) = 'object'),
  base jsonb not null check (jsonb_typeof(base) = 'object'),
  candidate jsonb not null check (jsonb_typeof(candidate) = 'object'),
  cohort jsonb not null check (jsonb_typeof(cohort) = 'object'),
  comparisons jsonb not null check (jsonb_typeof(comparisons) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  claim_id uuid,
  lease_until timestamptz,
  base_commit_sha text check (base_commit_sha ~ '^[a-f0-9]{40}$'),
  base_tree_sha text check (base_tree_sha ~ '^[a-f0-9]{40}$'),
  head_commit_sha text check (head_commit_sha ~ '^[a-f0-9]{40}$'),
  head_tree_sha text check (head_tree_sha ~ '^[a-f0-9]{40}$'),
  creation_armed boolean not null default false,
  creation_claim_id uuid,
  pull_number integer check (pull_number > 0),
  pull_url text,
  pull_state text check (pull_state in ('draft','open','closed','merged')),
  unique (workspace_id, factory_id, proposal_id, proposal_revision_id),
  foreign key (workspace_id, factory_id, proposal_id, proposal_revision_id)
    references internal.factory_improvement_proposal_revisions(workspace_id, factory_id, proposal_id, id) on delete cascade,
  check ((claim_id is null) = (lease_until is null)),
  check ((base_commit_sha is null) = (base_tree_sha is null)),
  check ((head_commit_sha is null) = (head_tree_sha is null)),
  check (head_commit_sha is null or base_commit_sha is not null),
  check (not creation_armed or head_commit_sha is not null),
  constraint factory_improvement_publications_creation_claim_check
    check (creation_armed = (creation_claim_id is not null)),
  check ((pull_number is null) = (pull_url is null) and (pull_number is null) = (pull_state is null)),
  check (pull_number is null or (creation_armed and claim_id is null))
);
create unique index factory_improvement_publications_pull_identity
  on internal.factory_improvement_publications((target->>'repositoryNumericId'),pull_number)
  where pull_number is not null;

alter table internal.factory_improvement_publication_targets enable row level security;
alter table internal.factory_improvement_publications enable row level security;
revoke all on internal.factory_improvement_publication_targets, internal.factory_improvement_publications
  from public, anon, authenticated, service_role;

create function internal.preserve_factory_improvement_publication()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if not exists (select 1 from public.factories f
      where (f.workspace_id, f.id) = (old.workspace_id, old.factory_id)) then return old; end if;
    raise exception 'Factory improvement publication history is immutable.' using errcode = '23514';
  end if;
  if old.pull_number is not null
    or (to_jsonb(new) - array['claim_id','lease_until','base_commit_sha','base_tree_sha',
      'head_commit_sha','head_tree_sha','creation_armed','creation_claim_id','pull_number','pull_url','pull_state'])
      is distinct from
      (to_jsonb(old) - array['claim_id','lease_until','base_commit_sha','base_tree_sha',
      'head_commit_sha','head_tree_sha','creation_armed','creation_claim_id','pull_number','pull_url','pull_state'])
    or (old.base_commit_sha is not null and
      (new.base_commit_sha,new.base_tree_sha) is distinct from (old.base_commit_sha,old.base_tree_sha))
    or (old.head_commit_sha is not null and
      (new.head_commit_sha,new.head_tree_sha) is distinct from (old.head_commit_sha,old.head_tree_sha)) then
    raise exception 'Factory improvement publication history is immutable.' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger preserve_factory_improvement_publication before update or delete
  on internal.factory_improvement_publications for each row execute function internal.preserve_factory_improvement_publication();

create function internal.factory_improvement_publication_target(
  p_workspace_id uuid, p_factory_id uuid, p_proposal_revision_id uuid
) returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', target.id, 'repositoryId', repository.id,
    'repositoryFullName', repository.full_name, 'repositoryNumericId', repository.repo_id,
    'installationId', installation.installation_id, 'baseBranch', target.base_branch,
    'headBranch', 'wallie/improvements/' || p_factory_id::text || '/' || p_proposal_revision_id::text,
    'configPath', '.wallie/factory-definitions/' || p_factory_id::text || '.json')
  from internal.factory_improvement_publication_targets target
  join public.github_repositories repository on (repository.workspace_id,repository.factory_id,repository.id) =
    (target.workspace_id,target.factory_id,target.repository_id) and not repository.is_archived
    and target.base_branch is distinct from repository.default_branch
    and repository.repo_id between 1 and 9007199254740991
    and repository.full_name ~ '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$'
  join public.github_installations installation
    on (installation.workspace_id,installation.id) = (repository.workspace_id,repository.github_installation_id)
    and not installation.suspended and installation.installation_id between 1 and 9007199254740991
  where (target.workspace_id,target.factory_id) = (p_workspace_id,p_factory_id);
$$;

create function internal.factory_improvement_publication_repository_authorized(
  publication internal.factory_improvement_publications
) returns boolean language sql stable set search_path = '' as $$
  select exists (select 1 from public.github_repositories repository
    join public.github_installations installation
      on (installation.workspace_id,installation.id) = (repository.workspace_id,repository.github_installation_id)
      and not installation.suspended
    where (repository.workspace_id,repository.factory_id,repository.id) =
      (publication.workspace_id,publication.factory_id,(publication.target->>'repositoryId')::uuid)
      and not repository.is_archived
      and repository.full_name = publication.target->>'repositoryFullName'
      and repository.repo_id = (publication.target->>'repositoryNumericId')::bigint
      and installation.installation_id = (publication.target->>'installationId')::bigint);
$$;

create function internal.factory_improvement_publication_scope_current(publication internal.factory_improvement_publications)
returns boolean language sql stable set search_path = '' as $$
  select publication.target is not distinct from internal.factory_improvement_publication_target(
    publication.workspace_id,publication.factory_id,publication.proposal_revision_id)
    and publication.base is not distinct from internal.current_factory_improvement_base(
      publication.workspace_id,publication.factory_id)
    and publication.proposal_revision_id = (select revision.id from internal.factory_improvement_proposal_revisions revision
      where (revision.workspace_id,revision.factory_id,revision.proposal_id) =
        (publication.workspace_id,publication.factory_id,publication.proposal_id)
      order by revision.revision_number desc limit 1)
    and internal.factory_improvement_disposition(publication.workspace_id,publication.factory_id,
      publication.proposal_id,publication.proposal_revision_id) <> 'dismissed'
    and exists (select 1 from public.factories factory where (factory.workspace_id,factory.id,factory.status) =
      (publication.workspace_id,publication.factory_id,'active'));
$$;

create function internal.project_factory_improvement_publication(publication internal.factory_improvement_publications)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id', publication.id, 'proposalId', publication.proposal_id,
    'proposalRevisionId', publication.proposal_revision_id, 'validationId', publication.validation_id,
    'createdAt', publication.created_at, 'base', publication.base, 'candidate', publication.candidate,
    'target', publication.target, 'cohort', publication.cohort, 'comparisons', publication.comparisons,
    'baseCommitSha', publication.base_commit_sha, 'baseTreeSha', publication.base_tree_sha,
    'headCommitSha', publication.head_commit_sha, 'headTreeSha', publication.head_tree_sha,
    'creationArmed', publication.creation_armed,
    'pullRequest', case when publication.pull_number is not null then jsonb_build_object(
      'number', publication.pull_number, 'url', publication.pull_url, 'state', publication.pull_state) end,
    'current', coalesce(internal.factory_improvement_publication_scope_current(publication), false));
$$;

create function public.set_factory_improvement_publication_target(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_repository_id uuid, p_base_branch text
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare target internal.factory_improvement_publication_targets;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  if p_repository_id is null or p_base_branch is null or
    p_base_branch !~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,179}$' or p_base_branch ~ '(\.\.|//|/\.|\.(lock)?$|/\.lock(/|$)|\.lock/|/$)'
    or p_base_branch like 'wallie/improvements/%' or p_base_branch like 'wallie/sessions/%' then
    raise exception 'Choose a valid definition repository and base branch.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.github_repositories repository
    join public.github_installations installation
      on (installation.workspace_id,installation.id) = (repository.workspace_id,repository.github_installation_id)
      and not installation.suspended
    where (repository.workspace_id,repository.factory_id,repository.id) = (p_workspace_id,p_factory_id,p_repository_id)
      and not repository.is_archived and repository.repo_id between 1 and 9007199254740991
      and p_base_branch is distinct from repository.default_branch) then
    raise exception 'Choose an active factory repository and a dedicated definition base branch.' using errcode = 'PT422';
  end if;
  insert into internal.factory_improvement_publication_targets(workspace_id,factory_id,repository_id,base_branch)
  values(p_workspace_id,p_factory_id,p_repository_id,p_base_branch)
  on conflict (workspace_id,factory_id) do update
    set id = excluded.id, repository_id = excluded.repository_id, base_branch = excluded.base_branch
    where (factory_improvement_publication_targets.repository_id,factory_improvement_publication_targets.base_branch)
      is distinct from (excluded.repository_id,excluded.base_branch);
  select * into strict target from internal.factory_improvement_publication_targets saved
  where (saved.workspace_id,saved.factory_id) = (p_workspace_id,p_factory_id);
  return jsonb_build_object('id',target.id,'repositoryId',target.repository_id,'baseBranch',target.base_branch,
    'configPath','.wallie/factory-definitions/' || p_factory_id::text || '.json');
end;
$$;

create function public.claim_factory_improvement_publication(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare actor uuid;
  publication internal.factory_improvement_publications;
  proposal internal.factory_improvement_proposal_revisions;
  validation internal.factory_improvement_validations;
  comparison jsonb;
  target jsonb;
  cohort jsonb;
  definition_json text;
begin
  perform internal.assert_checkpoint_publication_service();
  actor := internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  select * into publication from internal.factory_improvement_publications saved
  where (saved.workspace_id,saved.factory_id,saved.proposal_id,saved.proposal_revision_id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id);
  if publication.pull_number is not null then
    return jsonb_build_object('status','published','publication',internal.project_factory_improvement_publication(publication),
      'claim',null,'candidateDefinitionJson',null);
  end if;
  if publication.creation_armed then
    if not internal.factory_improvement_publication_repository_authorized(publication) then
      raise exception 'The previously armed publication repository is no longer authorized.' using errcode = 'PT409';
    end if;
  else
    target := internal.factory_improvement_publication_target(p_workspace_id,p_factory_id,p_proposal_revision_id);
    if publication.id is not null and target is distinct from publication.target then
      raise exception 'The configuration publication target changed.' using errcode = 'PT409';
    end if;
    if target is null then
      raise exception 'Configure an active definition repository first.' using errcode = 'PT422';
    end if;
  end if;
  if publication.lease_until > clock_timestamp() then
    return jsonb_build_object('status','busy','publication',internal.project_factory_improvement_publication(publication),
      'claim',null,'candidateDefinitionJson',null);
  end if;
  -- A previously armed POST is an outstanding GitHub observation, even
  -- after the proposal or its benchmark evidence becomes historical.
  if publication.creation_armed is not true then
    perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
    select * into proposal from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id,revision.factory_id,revision.proposal_id) = (p_workspace_id,p_factory_id,p_proposal_id)
    order by revision.revision_number desc limit 1;
    if not found then raise exception 'Improvement proposal is unavailable.' using errcode = 'P0002'; end if;
    if proposal.id is distinct from p_proposal_revision_id
      or proposal.intent->'base' is distinct from internal.current_factory_improvement_base(p_workspace_id,p_factory_id)
      or internal.factory_improvement_disposition(p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id) = 'dismissed' then
      raise exception 'The proposal revision, review decision, or active base changed.' using errcode = 'PT409';
    end if;
    select * into validation from internal.factory_improvement_validations compared
    where (compared.workspace_id,compared.factory_id,compared.proposal_id,compared.proposal_revision_id) =
      (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id);
    if validation.id is not null then comparison := internal.project_factory_improvement_validation(validation); end if;
    if comparison->>'status' is distinct from 'qualified' then
      raise exception 'Both suites must currently qualify this exact proposal revision.' using errcode = 'PT422';
    end if;
    select revision.definition_json into strict definition_json from public.factory_definition_revisions revision
    where (revision.workspace_id,revision.factory_id,revision.id,revision.canonical_digest) =
      (p_workspace_id,p_factory_id,proposal.candidate_revision_id,proposal.candidate_digest);
    if publication.id is null then
      select jsonb_build_object('id',diagnosis.cohort_id,'diagnosisId',diagnosis.id,
        'evidenceDigest',proposal.evidence_digest,'citedCount',cardinality(proposal.cited_member_ids))
      into strict cohort
      from internal.factory_improvement_proposals identity join internal.factory_diagnoses diagnosis
        on (diagnosis.workspace_id,diagnosis.factory_id,diagnosis.id) =
          (identity.workspace_id,identity.factory_id,identity.diagnosis_id)
      where (identity.workspace_id,identity.factory_id,identity.id) = (p_workspace_id,p_factory_id,p_proposal_id);
      insert into internal.factory_improvement_publications(workspace_id,factory_id,proposal_id,proposal_revision_id,
        validation_id,author_member_id,target,base,candidate,cohort,comparisons)
      values (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id,validation.id,actor,target,
        comparison->'base',comparison->'candidate',cohort,
        jsonb_build_object('targeted',comparison->'targeted','holdout',comparison->'holdout'))
      returning * into publication;
    end if;
  end if;
  update internal.factory_improvement_publications saved set claim_id = gen_random_uuid(),
    lease_until = clock_timestamp() + interval '2 minutes'
  where saved.id = publication.id returning * into publication;
  return jsonb_build_object('status','claimed','publication',internal.project_factory_improvement_publication(publication),
    'claim',jsonb_build_object('id',publication.claim_id,'expiresAt',publication.lease_until),
    'candidateDefinitionJson',definition_json);
end;
$$;

create function public.get_factory_improvement_publication(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_proposal_id uuid, p_proposal_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is null then
    raise exception 'Factory improvement publication is unavailable.' using errcode = '42501';
  end if;
  return (select internal.project_factory_improvement_publication(saved)
    from internal.factory_improvement_publications saved
    where (saved.workspace_id,saved.factory_id,saved.proposal_id,saved.proposal_revision_id) =
      (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id));
end;
$$;

create function public.advance_factory_improvement_publication(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_publication_id uuid, p_claim_id uuid,
  p_action text, p_values jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare publication internal.factory_improvement_publications;
  validation internal.factory_improvement_validations;
  expected_fields text[];
  pull_number integer;
begin
  perform internal.assert_checkpoint_publication_service();
  perform internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  select * into publication from internal.factory_improvement_publications saved
  where (saved.workspace_id,saved.factory_id,saved.id) = (p_workspace_id,p_factory_id,p_publication_id);
  if not found then raise exception 'Factory improvement publication is unavailable.' using errcode = 'P0002'; end if;
  if p_claim_id is null or publication.claim_id is distinct from p_claim_id
    or publication.lease_until <= clock_timestamp() or publication.pull_number is not null then
    raise exception 'The publication claim expired.' using errcode = 'PT409';
  end if;
  expected_fields := case p_action
    when 'freeze_base' then array['baseCommitSha','baseTreeSha']
    when 'pin_head' then array['headCommitSha','headTreeSha']
    when 'record_pr' then array['pullNumber','pullUrl','pullState']
    when 'authorize_head' then array[]::text[]
    when 'arm_create' then array[]::text[]
    when 'reset_create' then array[]::text[]
    when 'release' then array[]::text[]
  end;
  if expected_fields is null or jsonb_typeof(p_values) is distinct from 'object'
    or not (p_values ?& expected_fields) or p_values - expected_fields <> '{}' then
    raise exception 'Provide the publication step and its exact evidence.' using errcode = '22023';
  end if;

  if p_action in ('freeze_base','pin_head','authorize_head','arm_create') then
    if publication.creation_armed then
      raise exception 'Reconcile the previously armed pull request before creating another.' using errcode = 'PT409';
    end if;
    if not coalesce(internal.factory_improvement_publication_scope_current(publication),false) then
      raise exception 'The proposal, publication target, or active base changed.' using errcode = 'PT409';
    end if;
    select * into strict validation from internal.factory_improvement_validations comparison
    where comparison.id = publication.validation_id;
    if internal.project_factory_improvement_validation(validation)->>'status' is distinct from 'qualified' then
      raise exception 'Both suites must currently qualify this exact proposal revision.' using errcode = 'PT422';
    end if;
  end if;

  case p_action
    when 'freeze_base' then
      if publication.base_commit_sha is not null
        or not coalesce(p_values->>'baseCommitSha' ~ '^[a-f0-9]{40}$',false)
        or not coalesce(p_values->>'baseTreeSha' ~ '^[a-f0-9]{40}$',false) then
        raise exception 'The definition base was already frozen or its identity is incomplete.' using errcode = 'PT409';
      end if;
      publication.base_commit_sha := p_values->>'baseCommitSha';
      publication.base_tree_sha := p_values->>'baseTreeSha';
    when 'pin_head' then
      if publication.base_commit_sha is null or publication.head_commit_sha is not null
        or not coalesce(p_values->>'headCommitSha' ~ '^[a-f0-9]{40}$',false)
        or not coalesce(p_values->>'headTreeSha' ~ '^[a-f0-9]{40}$',false)
        or p_values->>'headCommitSha' = publication.base_commit_sha
        or p_values->>'headTreeSha' = publication.base_tree_sha then
        raise exception 'The definition head was already pinned or its identity is incomplete.' using errcode = 'PT409';
      end if;
      publication.head_commit_sha := p_values->>'headCommitSha';
      publication.head_tree_sha := p_values->>'headTreeSha';
    when 'authorize_head' then
      if publication.head_commit_sha is null then
        raise exception 'Pin the exact candidate before publishing its head.' using errcode = 'PT409';
      end if;
      return internal.project_factory_improvement_publication(publication);
    when 'arm_create' then
      if publication.head_commit_sha is null then
        raise exception 'Pin the exact candidate before arming pull request creation.' using errcode = 'PT409';
      end if;
      publication.creation_armed := true;
      publication.creation_claim_id := p_claim_id;
    when 'reset_create' then
      if publication.creation_armed and publication.creation_claim_id is distinct from p_claim_id then
        raise exception 'A recovery lease cannot reset a previously armed pull request.' using errcode = 'PT409';
      end if;
      publication.creation_armed := false;
      publication.creation_claim_id := null;
      publication.claim_id := null;
      publication.lease_until := null;
    when 'record_pr' then
      if not publication.creation_armed or not coalesce(pg_input_is_valid(p_values->>'pullNumber','integer'),false)
        or coalesce(p_values->>'pullState','') not in ('draft','open','closed','merged') then
        raise exception 'Verify the previously armed pull request.' using errcode = 'PT409';
      end if;
      if not internal.factory_improvement_publication_repository_authorized(publication) then
        raise exception 'The previously armed publication repository is no longer authorized.' using errcode = 'PT409';
      end if;
      pull_number := (p_values->>'pullNumber')::integer;
      if pull_number < 1 or p_values->>'pullUrl' is distinct from
        ('https://github.com/' || (publication.target->>'repositoryFullName') || '/pull/' || pull_number::text) then
        raise exception 'Use the exact configuration repository pull request.' using errcode = 'PT409';
      end if;
      publication.pull_number := pull_number;
      publication.pull_url := p_values->>'pullUrl';
      publication.pull_state := p_values->>'pullState';
      publication.claim_id := null;
      publication.lease_until := null;
    when 'release' then
      publication.claim_id := null;
      publication.lease_until := null;
  end case;
  update internal.factory_improvement_publications saved set
    claim_id = publication.claim_id, lease_until = publication.lease_until,
    base_commit_sha = publication.base_commit_sha, base_tree_sha = publication.base_tree_sha,
    head_commit_sha = publication.head_commit_sha, head_tree_sha = publication.head_tree_sha,
    creation_armed = publication.creation_armed, creation_claim_id = publication.creation_claim_id,
    pull_number = publication.pull_number,
    pull_url = publication.pull_url, pull_state = publication.pull_state
  where saved.id = publication.id returning * into publication;
  return internal.project_factory_improvement_publication(publication);
end;
$$;

revoke all on function internal.preserve_factory_improvement_publication(),
  internal.factory_improvement_publication_target(uuid,uuid,uuid),
  internal.factory_improvement_publication_repository_authorized(internal.factory_improvement_publications),
  internal.factory_improvement_publication_scope_current(internal.factory_improvement_publications),
  internal.project_factory_improvement_publication(internal.factory_improvement_publications),
  public.set_factory_improvement_publication_target(uuid,uuid,uuid,uuid,text),
  public.claim_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid),
  public.get_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid),
  public.advance_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.set_factory_improvement_publication_target(uuid,uuid,uuid,uuid,text),
  public.claim_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid),
  public.get_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid),
  public.advance_factory_improvement_publication(uuid,uuid,uuid,uuid,uuid,text,jsonb)
  to service_role;
