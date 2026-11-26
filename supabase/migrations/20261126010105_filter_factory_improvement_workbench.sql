drop function public.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid);
drop function internal.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid);

create function internal.list_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer, p_after_proposal_id uuid,
  p_cohort_id uuid, p_review_state text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  after_created_at timestamptz;
  after_proposal_id uuid;
begin
  if auth.uid() is null or not internal.can_access_factory(p_workspace_id, p_factory_id) then
    raise exception 'Factory improvements are unavailable.' using errcode = 'P0002';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Provide a valid improvements page size.' using errcode = '22023';
  end if;
  if p_review_state is not null and p_review_state not in ('open', 'investigate', 'revise', 'dismissed') then
    raise exception 'Provide a valid improvement review state.' using errcode = '22023';
  end if;
  if p_after_proposal_id is not null then
    select revision.created_at, revision.proposal_id into after_created_at, after_proposal_id
    from internal.factory_improvement_proposal_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.id) =
      (p_workspace_id, p_factory_id, p_after_proposal_id);
    if not found then
      select revision.created_at, revision.proposal_id into after_created_at, after_proposal_id
      from internal.factory_improvement_proposal_revisions revision
      where (revision.workspace_id, revision.factory_id, revision.proposal_id) =
        (p_workspace_id, p_factory_id, p_after_proposal_id)
      order by revision.revision_number desc limit 1;
    end if;
    if not found then raise exception 'Proposal page is unavailable.' using errcode = 'P0002'; end if;
  end if;

  return (
    with page as materialized (
      select proposal.id as proposal_id, proposal.diagnosis_id,
        diagnosis.cohort_id, latest.id as revision_id, latest.revision_number, latest.candidate_revision_id,
        latest.intent, latest.created_at, review.disposition,
        row_number() over (order by latest.created_at desc, proposal.id desc) as position
      from internal.factory_improvement_proposals proposal
      join lateral (
        select revision.id, revision.revision_number, revision.candidate_revision_id, revision.intent, revision.created_at
        from internal.factory_improvement_proposal_revisions revision
        where (revision.workspace_id, revision.factory_id, revision.proposal_id) =
          (proposal.workspace_id, proposal.factory_id, proposal.id)
        order by revision.revision_number desc limit 1
      ) latest on true
      left join internal.factory_diagnoses diagnosis on
        (diagnosis.workspace_id, diagnosis.factory_id, diagnosis.id) = (proposal.workspace_id, proposal.factory_id, proposal.diagnosis_id)
      cross join lateral (
        select internal.factory_improvement_disposition(p_workspace_id, p_factory_id, proposal.id, latest.id) as disposition
      ) review
      where (proposal.workspace_id, proposal.factory_id) = (p_workspace_id, p_factory_id)
        and (p_cohort_id is null or diagnosis.cohort_id = p_cohort_id)
        and (p_review_state is null or review.disposition = p_review_state)
        and (p_after_proposal_id is null or (latest.created_at, proposal.id) < (after_created_at, after_proposal_id))
      order by latest.created_at desc, proposal.id desc limit p_limit + 1
    )
    select jsonb_build_object('proposals', coalesce(jsonb_agg(jsonb_build_object(
      'proposalId', item.proposal_id, 'revisionId', item.revision_id, 'revisionNumber', item.revision_number,
      'diagnosisId', item.diagnosis_id, 'cohortId', item.cohort_id, 'rationale', item.intent->'rationale',
      'expectedBenefit', item.intent->'expectedBenefit', 'createdAt', item.created_at,
      'status', case when item.candidate_revision_id is null then 'invalid' else 'compiled' end,
      'baseCurrent', coalesce(item.intent->'base' = internal.current_factory_improvement_base(p_workspace_id, p_factory_id), false),
      'disposition', item.disposition
    ) order by item.position) filter (where item.position <= p_limit), '[]'::jsonb),
    'nextProposalId', case when count(*) > p_limit then (array_agg(item.proposal_id order by item.position))[p_limit] end,
    'nextRevisionId', case when count(*) > p_limit then (array_agg(item.revision_id order by item.position))[p_limit] end)
    from page item
  );
end;
$$;

create function public.list_factory_improvement_workbench(
  p_workspace_id uuid, p_factory_id uuid, p_limit integer default 24,
  p_after_proposal_id uuid default null, p_cohort_id uuid default null, p_review_state text default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select internal.list_factory_improvement_workbench(
    p_workspace_id, p_factory_id, p_limit, p_after_proposal_id, p_cohort_id, p_review_state
  )
$$;

revoke all on function
  internal.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid, text),
  public.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function
  internal.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid, text),
  public.list_factory_improvement_workbench(uuid, uuid, integer, uuid, uuid, text)
  to authenticated;
