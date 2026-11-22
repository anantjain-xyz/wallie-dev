create table internal.factory_improvement_adoptions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  proposal_id uuid not null,
  proposal_revision_id uuid not null,
  publication_id uuid not null references internal.factory_improvement_publications(id) deferrable initially deferred,
  validation_id uuid not null references internal.factory_improvement_validations(id) deferrable initially deferred,
  actor_member_id uuid not null,
  baseline_activation_number bigint not null,
  baseline_revision_id uuid not null,
  baseline_digest text not null check (baseline_digest ~ '^[a-f0-9]{64}$'),
  activation_number bigint not null check (activation_number = baseline_activation_number + 1),
  adopted_revision_id uuid not null,
  adopted_digest text not null check (adopted_digest ~ '^[a-f0-9]{64}$'),
  review jsonb not null check (jsonb_typeof(review) = 'object'),
  comparisons jsonb not null check (jsonb_typeof(comparisons) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id,factory_id,id),
  unique (workspace_id,factory_id,activation_number),
  unique (workspace_id,factory_id,proposal_id,proposal_revision_id),
  foreign key (workspace_id,factory_id,proposal_id,proposal_revision_id)
    references internal.factory_improvement_proposal_revisions(workspace_id,factory_id,proposal_id,id) on delete cascade,
  foreign key (workspace_id,factory_id,baseline_activation_number)
    references public.factory_definition_activations(workspace_id,factory_id,activation_number) deferrable initially deferred,
  foreign key (workspace_id,factory_id,activation_number)
    references public.factory_definition_activations(workspace_id,factory_id,activation_number) deferrable initially deferred,
  foreign key (workspace_id,factory_id,baseline_revision_id)
    references public.factory_definition_revisions(workspace_id,factory_id,id) deferrable initially deferred,
  foreign key (workspace_id,factory_id,adopted_revision_id)
    references public.factory_definition_revisions(workspace_id,factory_id,id) deferrable initially deferred
);
alter table internal.factory_improvement_adoptions enable row level security;
revoke all on internal.factory_improvement_adoptions from public, anon, authenticated, service_role;
create trigger preserve_factory_improvement_adoptions before update or delete
  on internal.factory_improvement_adoptions for each row execute function internal.preserve_factory_improvement_history();

create function internal.project_factory_improvement_adoption(adoption internal.factory_improvement_adoptions)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('id',adoption.id,'proposalId',adoption.proposal_id,
    'proposalRevisionId',adoption.proposal_revision_id,'publicationId',adoption.publication_id,
    'validationId',adoption.validation_id,'actorMemberId',adoption.actor_member_id,
    'createdAt',adoption.created_at,'review',adoption.review,'comparisons',adoption.comparisons,
    'baseline',jsonb_build_object('activationNumber',adoption.baseline_activation_number,
      'revisionId',adoption.baseline_revision_id,'digest',adoption.baseline_digest),
    'adopted',jsonb_build_object('activationNumber',adoption.activation_number,
      'revisionId',adoption.adopted_revision_id,'digest',adoption.adopted_digest));
$$;

create function internal.assert_factory_improvement_review_proof(
  publication internal.factory_improvement_publications,p_review jsonb
) returns void language plpgsql stable set search_path = '' as $$
declare fields text[] := array['repositoryNumericId','pullNumber','pullUrl','baseCommitSha','headCommitSha',
  'mergeCommitSha','reviewerId','reviewerLogin','reviewId','reviewedAt','mergedAt','observedAt'];
begin
  if jsonb_typeof(p_review) is distinct from 'object' or not (p_review ?& fields)
    or p_review - fields <> '{}' or publication.pull_number is null
    or jsonb_typeof(p_review->'repositoryNumericId') is distinct from 'number'
    or jsonb_typeof(p_review->'pullNumber') is distinct from 'number'
    or exists (select 1 from unnest(array['pullUrl','baseCommitSha','headCommitSha','mergeCommitSha',
      'reviewerLogin','reviewId','reviewedAt','mergedAt','observedAt']) field
      where jsonb_typeof(p_review->field) is distinct from 'string')
    or p_review->>'repositoryNumericId' is distinct from publication.target->>'repositoryNumericId'
    or p_review->>'pullNumber' is distinct from publication.pull_number::text
    or p_review->>'pullUrl' is distinct from publication.pull_url
    or p_review->>'baseCommitSha' is distinct from publication.base_commit_sha
    or p_review->>'headCommitSha' is distinct from publication.head_commit_sha
    or not coalesce(p_review->>'mergeCommitSha' ~ '^[a-f0-9]{40}$',false)
    or jsonb_typeof(p_review->'reviewerId') is distinct from 'number'
    or not coalesce(pg_input_is_valid(p_review->>'reviewerId','bigint'),false)
    or not coalesce(char_length(p_review->>'reviewerLogin') between 1 and 80,false)
    or not coalesce(char_length(p_review->>'reviewId') between 1 and 256,false)
    or not coalesce(pg_input_is_valid(p_review->>'reviewedAt','timestamptz'),false)
    or not coalesce(pg_input_is_valid(p_review->>'mergedAt','timestamptz'),false)
    or not coalesce(pg_input_is_valid(p_review->>'observedAt','timestamptz'),false) then
    raise exception 'The exact merged pull request and authorized human review are required.' using errcode = 'PT422';
  end if;
  if (p_review->>'reviewerId')::bigint not between 1 and 9007199254740991
    or not isfinite((p_review->>'reviewedAt')::timestamptz)
    or not isfinite((p_review->>'mergedAt')::timestamptz)
    or not isfinite((p_review->>'observedAt')::timestamptz)
    or (p_review->>'reviewedAt')::timestamptz > (p_review->>'mergedAt')::timestamptz
    or (p_review->>'mergedAt')::timestamptz > (p_review->>'observedAt')::timestamptz
    or (p_review->>'observedAt')::timestamptz not between
      statement_timestamp() - interval '2 minutes' and statement_timestamp() + interval '5 seconds' then
    raise exception 'Refresh the exact human review for the merged candidate.' using errcode = 'PT422';
  end if;
end;
$$;

create function public.get_factory_improvement_adoption(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_proposal_id uuid,p_proposal_revision_id uuid
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.assert_checkpoint_publication_service();
  if internal.factory_benchmark_comparison_manager(p_workspace_id,p_factory_id,p_actor_user_id) is null then
    raise exception 'Factory improvement adoption is unavailable.' using errcode = '42501';
  end if;
  return (select internal.project_factory_improvement_adoption(adoption)
    from internal.factory_improvement_adoptions adoption
    where (adoption.workspace_id,adoption.factory_id,adoption.proposal_id,adoption.proposal_revision_id) =
      (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id));
end;
$$;

create function public.adopt_factory_improvement(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_proposal_id uuid,p_proposal_revision_id uuid,
  p_publication_id uuid,p_expected_activation_number bigint,p_candidate_digest text,p_head_commit_sha text,
  p_reviewed_definition_json text,p_review jsonb,p_enabled_sandbox_providers text[],p_required_probes text[]
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  reviewer_member_id uuid;
  saved internal.factory_improvement_adoptions;
  publication internal.factory_improvement_publications;
  head public.factory_definition_activations;
  activation public.factory_definition_activations;
  baseline public.factory_definition_revisions;
  candidate public.factory_definition_revisions;
  proposal internal.factory_improvement_proposal_revisions;
  diagnosis internal.factory_diagnoses;
  validation internal.factory_improvement_validations;
  qualified jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  perform pg_advisory_xact_lock(hashtextextended(p_workspace_id::text,0));
  perform 1 from public.workspaces workspace
  where workspace.id = p_workspace_id and workspace.deletion_requested_at is null for no key update;
  if not found then raise exception 'Factory workspace is unavailable.' using errcode = 'P0002'; end if;
  select member.id into reviewer_member_id from public.workspace_members member
  where (member.workspace_id,member.user_id) = (p_workspace_id,p_actor_user_id)
    and member.kind = 'human' and member.is_active and member.role in ('owner','admin');
  if not found then raise exception 'An active human workspace manager is required.' using errcode = '42501'; end if;

  select * into saved from internal.factory_improvement_adoptions adoption
  where (adoption.workspace_id,adoption.factory_id,adoption.proposal_id,adoption.proposal_revision_id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id);
  if found then
    if (saved.publication_id,saved.baseline_activation_number,saved.adopted_digest,saved.review->>'headCommitSha')
      is distinct from (p_publication_id,p_expected_activation_number,p_candidate_digest,p_head_commit_sha) then
      raise exception 'This proposal already has a different adoption receipt.' using errcode = 'PT409';
    end if;
    return jsonb_build_object('adoption',internal.project_factory_improvement_adoption(saved),'replay',true);
  end if;

  head := internal.lock_factory_definition_head(p_workspace_id,p_factory_id,p_actor_user_id,p_expected_activation_number);
  select * into publication from internal.factory_improvement_publications published
  where (published.workspace_id,published.factory_id,published.proposal_id,published.proposal_revision_id,published.id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id,p_publication_id);
  if not found or publication.pull_number is null then
    raise exception 'The verified configuration pull request is unavailable.' using errcode = 'P0002';
  end if;
  if (publication.base->>'activationNumber',publication.base->>'revisionId',publication.candidate->>'digest',
      publication.head_commit_sha) is distinct from
    (head.activation_number::text,head.revision_id::text,p_candidate_digest,p_head_commit_sha) then
    raise exception 'The active base, candidate, or reviewed head changed.' using errcode = 'PT409';
  end if;

  perform 1 from public.github_installations installation
    where (installation.workspace_id,installation.installation_id) =
      (p_workspace_id,(publication.target->>'installationId')::bigint) for share nowait;
  perform 1 from public.github_repositories repository where (repository.workspace_id,repository.factory_id,repository.id) =
    (p_workspace_id,p_factory_id,(publication.target->>'repositoryId')::uuid) for share nowait;
  if not coalesce(internal.factory_improvement_publication_scope_current(publication),false)
    or not internal.factory_improvement_publication_repository_authorized(publication) then
    raise exception 'The publication target, current proposal, or active base changed.' using errcode = 'PT409';
  end if;
  perform internal.assert_factory_improvement_review_proof(publication,p_review);

  select * into strict proposal from internal.factory_improvement_proposal_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.proposal_id,revision.id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id);
  select job.* into strict diagnosis from internal.factory_improvement_proposals identity
  join internal.factory_diagnoses job on (job.workspace_id,job.factory_id,job.id) =
    (identity.workspace_id,identity.factory_id,identity.diagnosis_id)
  where (identity.workspace_id,identity.factory_id,identity.id) = (p_workspace_id,p_factory_id,p_proposal_id);
  perform internal.lock_factory_improvement_source_repositories(diagnosis);
  perform internal.lock_factory_improvement_source_objects(diagnosis);

  select * into validation from internal.factory_improvement_validations comparison
  where (comparison.workspace_id,comparison.factory_id,comparison.proposal_id,comparison.proposal_revision_id,comparison.id) =
    (p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id,publication.validation_id);
  if found then qualified := internal.project_factory_improvement_validation(validation); end if;
  if qualified->>'status' is distinct from 'qualified'
    or (qualified->'base',qualified->'candidate',qualified#>>'{targeted,experimentId}',qualified#>>'{holdout,experimentId}')
      is distinct from (publication.base,publication.candidate,publication.comparisons#>>'{targeted,experimentId}',
        publication.comparisons#>>'{holdout,experimentId}') then
    raise exception 'Current qualified targeted and held-out evidence is required.' using errcode = 'PT422';
  end if;

  select * into strict baseline from public.factory_definition_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.id) = (p_workspace_id,p_factory_id,head.revision_id);
  select * into strict candidate from public.factory_definition_revisions revision
  where (revision.workspace_id,revision.factory_id,revision.id) =
    (p_workspace_id,p_factory_id,proposal.candidate_revision_id);
  if baseline.canonical_digest is distinct from publication.base->>'digest'
    or (candidate.id::text,candidate.canonical_digest,candidate.definition_json) is distinct from
      (publication.candidate->>'revisionId',p_candidate_digest,p_reviewed_definition_json) then
    raise exception 'The reviewed definition differs from the tested candidate.' using errcode = 'PT422';
  end if;
  perform internal.assert_factory_activation_authority(p_workspace_id,p_actor_user_id,candidate.definition_json::jsonb,
    candidate.canonical_digest,p_enabled_sandbox_providers,p_required_probes);
  -- The shared authority check locks the pipeline before the human membership.
  select member.id into strict reviewer_member_id from public.workspace_members member
  where (member.workspace_id,member.user_id) = (p_workspace_id,p_actor_user_id)
    and member.kind = 'human' and member.is_active and member.role in ('owner','admin');
  perform internal.assert_factory_skill_bundle_available(p_workspace_id,p_factory_id,candidate.definition_json::jsonb->'skillIds');

  insert into public.factory_definition_activations(workspace_id,factory_id,revision_id,activation_number,created_by)
  values(p_workspace_id,p_factory_id,candidate.id,head.activation_number + 1,p_actor_user_id)
  returning * into activation;
  insert into internal.factory_improvement_adoptions(workspace_id,factory_id,proposal_id,proposal_revision_id,
    publication_id,validation_id,actor_member_id,baseline_activation_number,baseline_revision_id,baseline_digest,
    activation_number,adopted_revision_id,adopted_digest,review,comparisons)
  values(p_workspace_id,p_factory_id,p_proposal_id,p_proposal_revision_id,publication.id,validation.id,reviewer_member_id,
    head.activation_number,baseline.id,baseline.canonical_digest,activation.activation_number,candidate.id,
    candidate.canonical_digest,p_review,jsonb_build_object('targeted',qualified->'targeted','holdout',qualified->'holdout'))
  returning * into saved;
  perform internal.record_factory_improvement_routing(saved,p_actor_user_id,
    baseline.definition_json::jsonb,candidate.definition_json::jsonb,proposal.intent->'edits');
  return jsonb_build_object('adoption',internal.project_factory_improvement_adoption(saved),'replay',false);
exception when lock_not_available then
  raise exception 'Factory evidence authority changed. Reload before retrying.' using errcode = 'PT409';
end;
$$;

revoke all on function internal.project_factory_improvement_adoption(internal.factory_improvement_adoptions),
  internal.assert_factory_improvement_review_proof(internal.factory_improvement_publications,jsonb),
  public.get_factory_improvement_adoption(uuid,uuid,uuid,uuid,uuid),
  public.adopt_factory_improvement(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_factory_improvement_adoption(uuid,uuid,uuid,uuid,uuid),
  public.adopt_factory_improvement(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text[],text[])
  to service_role;
