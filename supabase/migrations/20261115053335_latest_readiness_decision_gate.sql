create or replace function internal.assert_delivery_readiness_gate(p_session_id uuid, p_workspace_id uuid)
returns void language plpgsql stable security invoker set search_path='' as $$
declare reviewed public.sessions%rowtype;
  policy public.delivery_policies%rowtype;
  requirements jsonb;
  decision record;
begin
  select s.* into reviewed from public.sessions s
    where s.id=p_session_id and s.workspace_id=p_workspace_id;
  if reviewed.id is null then
    raise exception 'Delivery gate session is unavailable.' using errcode='42501';
  end if;
  select p.* into policy from public.delivery_policies p
    where p.pipeline_id=reviewed.pipeline_id and p.workspace_id=p_workspace_id;
  -- No configured policy: a review-only pipeline continues without a PR gate.
  if policy.pipeline_id is null then return; end if;
  select r.requirements into requirements from public.delivery_policy_revisions r
    where r.id=policy.current_revision_id;
  -- Analysis delivery is explicitly not applicable: no synthetic PR or merge.
  if requirements is null or requirements->>'deliveryMode' is distinct from 'code' then return; end if;
  -- Delivery without required artifact approval does not gate on readiness.
  if (requirements->>'requireArtifactApprovalForDelivery')::boolean is distinct from true then return; end if;

  -- Inspect the newest current decision before checking whether it is Ready.
  -- A failed verification of a previously available report must supersede
  -- the prior Ready decision for the same GitHub observation.
  -- The decision must remain current for the exact repository,
  -- canonical PR epoch/number, head/base SHA, accepted checkpoint, policy
  -- revision and artifact-review revision it was bound to, within configured
  -- freshness. It must also consume the queue's latest completed GitHub
  -- observation: the evaluator records the observation id it actually read,
  -- so a decision evaluated from a superseded collection — a refresh that
  -- landed between the evaluator's read and its recording, with unchanged
  -- head/base SHAs — cannot pass here even though the currentness view's
  -- created_at ordering is satisfied.
  select c.id, c.state, o.payload as readiness_payload,
      q.last_observation_id as consumed_observation_id
    into decision
    from public.session_pr_verification_currentness c
    join public.session_pr_verification_observations o on o.id=c.observation_id
    join public.session_pr_refresh_queue q on q.session_id=c.session_id
    where c.session_id=p_session_id and c.workspace_id=p_workspace_id
      and c.is_current and o.source='readiness'
    order by c.created_at desc, c.id desc limit 1;
  if decision.id is null then
    if exists (
      select 1 from public.session_pr_verification_results r
      join public.session_pr_verification_observations o on o.id=r.observation_id
      where r.session_id=p_session_id and r.workspace_id=p_workspace_id
        and r.state='ready' and o.source='readiness') then
      raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
        using errcode='PT428';
    end if;
    raise exception 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.'
      using errcode='PT428';
  end if;
  -- Bind the accepted decision to the exact observation it consumed. A null
  -- or absent sourceObservationId fails closed here.
  if (decision.readiness_payload->>'sourceObservationId')::uuid
      is distinct from decision.consumed_observation_id then
    raise exception 'PR readiness decision is stale. Refresh PR verification and approve again.'
      using errcode='PT428';
  end if;
  if decision.state is distinct from 'ready' then
    raise exception 'PR readiness is not Ready. Resolve the reported delivery blockers before approving.'
      using errcode='PT428';
  end if;
end;
$$;
