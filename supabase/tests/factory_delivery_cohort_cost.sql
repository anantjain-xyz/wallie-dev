begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '59400000-0000-4000-8000-000000000001';

create function pg_temp.cost_id(slot integer) returns uuid language sql immutable as $$
  select ('59400000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

select public.set_git_continuity_release(true, revision, 'Factory cost reconciliation fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into auth.users(id, email) values (pg_temp.cost_id(1), 'factory-cost-owner@example.test'),
  (pg_temp.cost_id(98), 'factory-cost-member@example.test'),
  (pg_temp.cost_id(99), 'factory-cost-outsider@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.cost_id(2), 'factory-cost-fixture', 'Factory cost fixture');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.cost_id(3), pg_temp.cost_id(2), pg_temp.cost_id(1), 'human', 'owner'),
  (pg_temp.cost_id(97), pg_temp.cost_id(2), pg_temp.cost_id(98), 'human', 'member');
create temp table sibling_factory as select * from public.create_factory(
  pg_temp.cost_id(2), pg_temp.cost_id(1), 'Restricted cost factory', 'restricted-cost');

create function pg_temp.cost_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.cost_id(2) and is_default
$$;
insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
values (pg_temp.cost_id(4), pg_temp.cost_id(2), pg_temp.cost_factory(), 'Cost fixture pipeline', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md, anyone_can_approve)
values (pg_temp.cost_id(5), pg_temp.cost_id(4), pg_temp.cost_id(2), 1, 'deliver', 'Deliver', 'Record attributable output.', true);
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.cost_id(6), pg_temp.cost_id(2), 59400006, 'https://github.test/installations/59400006',
  594000, 'Organization', 'cost-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
values (pg_temp.cost_id(7), pg_temp.cost_id(2), pg_temp.cost_id(6), 59400007, 'cost', 'fixture/cost', true,
  'https://github.test/fixture/cost', 'main');
insert into public.user_codex_credentials(user_id, credential_type, encrypted_credential)
values (pg_temp.cost_id(1), 'platform_api_key', 'synthetic-cost-fixture-ciphertext');

create function pg_temp.make_cost_session(title text)
returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language sql as $$
  select * from public.create_session_with_first_job(pg_temp.cost_id(2), pg_temp.cost_id(3),
    title, 'Produce the exact retained evidence.', 'codex', 'gpt-5.5', null, null, pg_temp.cost_id(7), pg_temp.cost_id(4))
$$;

create function pg_temp.publish_cost_attempt(target_job uuid, output_sha text, cost numeric)
returns uuid language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs; started uuid; claim uuid; retained text;
begin
  select session.* into strict owner
  from public.sessions session join public.agent_jobs job on job.session_id = session.id where job.id = target_job;
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state()) where id = target_job;
  started := public.start_session_job_attempt(target_job, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/cost-' || target_job::text);
  select * into selected from public.session_job_git_inputs where job_id = target_job;
  perform public.pin_session_job_git_input(target_job, 1, started, pg_temp.cost_id(7),
    coalesce(selected.base_branch, 'main'), coalesce(selected.input_sha, repeat('a', 40)));
  select * into strict selected from public.session_job_git_inputs where job_id = target_job;
  if not exists (
    select 1 from public.record_session_run_usage(target_job, 1, started, p_cost_usd => cost,
      p_cost_provenance => 'measured', p_finalize => true) usage where usage.accepted
  ) then raise exception 'Fixture could not record production attempt usage.'; end if;
  if not public.prepare_session_source_and_checkpoint_publication(
    started, selected.repository_id, selected.base_branch, selected.input_sha, output_sha,
    'Cost checkpoint', 'Canonical PR body', '',
    encode(extensions.digest('cost fixture source'::bytea, 'sha256'), 'hex'),
    encode('cost fixture source'::bytea, 'base64'), owner.current_artifact_version, 'Cost fixture accepted artifact'
  ) then raise exception 'Fixture could not prepare its checkpoint.'; end if;
  claim := public.claim_session_checkpoint_publication(started);
  select retained_ref into strict retained from public.session_checkpoint_publications where run_id = started;
  if claim is null or not public.adopt_session_checkpoint_publication(started, claim, retained, output_sha)
    then raise exception 'Fixture could not adopt its checkpoint.'; end if;
  return started;
end;
$$;

create function pg_temp.observe_cost_merge(
  target_epoch uuid, pr_number integer, merged_at timestamptz,
  provider_updated_at timestamptz, merge_sha text, source_sha text
) returns boolean language plpgsql as $$
declare epoch public.session_pr_epochs; observation uuid;
begin
  select * into strict epoch from public.session_pr_epochs where id = target_epoch;
  observation := public.begin_session_pr_observation(epoch.workspace_id, epoch.repository_id, epoch.branch_name, pr_number);
  return public.finish_session_pr_observation_with_merge(observation, epoch.pr_url, 'merged', false,
    source_sha, provider_updated_at, merged_at, merge_sha, source_sha);
end;
$$;

create function pg_temp.deliver_cost_epoch(target_session uuid, number integer, merged_at timestamptz, merge_sha text)
returns uuid language plpgsql as $$
declare claim uuid; operation public.session_pr_operations; observation uuid; pr_url text;
begin
  claim := public.claim_session_pr_sync(target_session);
  select * into strict operation from public.session_pr_operations where claim_id = claim;
  if not public.arm_session_pr_creation(operation.epoch_id, operation.id, claim)
    then raise exception 'Fixture could not authorize its canonical PR.'; end if;
  pr_url := 'https://github.com/fixture/cost/pull/' || number::text;
  observation := public.begin_session_pr_sync_observation(operation.id, claim, number, pr_url);
  if not public.finish_session_pr_sync(operation.id, claim, operation.desired_sha, operation.desired_fence_sha,
    number, pr_url, 'open', true, operation.desired_sha, merged_at - interval '1 minute', observation)
    then raise exception 'Fixture could not establish the exact open PR receipt.'; end if;
  if not pg_temp.observe_cost_merge(operation.epoch_id, number, merged_at, merged_at, merge_sha, operation.desired_sha)
    then raise exception 'Fixture could not observe its exact canonical merge.'; end if;
  return operation.epoch_id;
end;
$$;

create temp table cost_clock as select now() - interval '2 days' first_merged_at,
  now() - interval '24 hours' period_from, now() + interval '1 day' period_to;
create temp table delivered as select * from pg_temp.make_cost_session('Delivered twice');
create temp table first_run as
select pg_temp.publish_cost_attempt(job_id, repeat('b', 40), 17) run_id from delivered;
update public.agent_runs set started_at = now() - interval '3 days', finished_at = now() - interval '49 hours'
where id = (select run_id from first_run);
create temp table first_epoch as
select pg_temp.deliver_cost_epoch(session_id, 59401, first_merged_at, repeat('e', 40)) epoch_id
from delivered cross join cost_clock;

create temp table successor_job as
select queued.job_id from public.sessions session
cross join lateral public.reject_session_stage(session.id, session.workspace_id, session.current_artifact_version,
  'Revise for the next delivery', 'codex', 'gpt-5.5', session.current_stage_id, session.current_artifact_id,
  'project', pg_temp.cost_id(3)) queued
where session.id = (select session_id from delivered);
create temp table successor_run as
select pg_temp.publish_cost_attempt(job_id, repeat('c', 40), 7) run_id from successor_job;
select ok((select public.authorize_session_pr_successor(pg_temp.cost_id(1), session_id, epoch_id, pg_temp.cost_id(8))
  is not null from delivered cross join first_epoch), 'an authorized successor creates a distinct canonical PR epoch');
create temp table second_merge_time as select clock_timestamp() merged_at;
create temp table second_epoch as
select pg_temp.deliver_cost_epoch(session_id, 59402, merged_at, repeat('f', 40)) epoch_id
from delivered cross join second_merge_time;
select ok((select pg_temp.observe_cost_merge(epoch_id, 59402, merged_at, merged_at, repeat('f', 40), repeat('c', 40))
  from second_epoch cross join second_merge_time), 'duplicate authenticated observations settle without another merge');
create temp table abandoned as select * from pg_temp.make_cost_session('Abandoned period work');

-- The retained summaries can outlive their job rows. Use detached fixtures for
-- negative/pending cases and reconcile them with the real fenced receipts above.
insert into public.agent_runs (
  id, workspace_id, session_id, stage_id, run_type, model_provider, model_name, status,
  started_at, finished_at, cost_provenance, total_cost_usd, usage_finalized_at, usage_estimation_revision
)
select pg_temp.cost_id(sample.slot), pg_temp.cost_id(2), owner.session_id, pg_temp.cost_id(5), 'project', 'codex',
  'gpt-5.5', sample.status::public.agent_run_status, now() + sample.start_offset::interval,
  now() + sample.finish_offset::interval, sample.provenance, sample.cost,
  now() + sample.finish_offset::interval, case when sample.provenance = 'estimated' then 'fixture-price-v1' end
from (values
  (31, 'error', '-72 hours', '-50 hours', 'measured', 11::numeric, false),
  (32, 'error', '-47 hours', '-46 hours', 'estimated', 3, false),
  (33, 'canceled', '-11 hours', '-10 hours', 'measured', 4, false),
  (34, 'error', '-9 hours', '-8 hours', 'unavailable', null, false),
  (35, 'error', '-49 hours', '-47 hours', 'measured', 20, false),
  (36, 'running', '-6 hours', null, 'measured', 99, false),
  (37, 'canceled', '-5 hours', '-4 hours', 'measured', 0, false),
  (38, 'success', '-3 hours', '-2 hours', 'measured', 5, true),
  (39, 'success', '2 hours', '3 hours', 'measured', 6, false)
) sample(slot, status, start_offset, finish_offset, provenance, cost, other_session)
cross join lateral (
  select case when sample.other_session then abandoned.session_id else delivered.session_id end as session_id
  from delivered cross join abandoned
) owner;

create function pg_temp.cost_summary(p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable as $$
  select public.get_factory_cost_summary(pg_temp.cost_id(2), pg_temp.cost_factory(), p_from, p_to)
$$;
create temp table second_summary as select pg_temp.cost_summary(period_from, period_to) result from cost_clock;
select is((select (result #>> '{mergeCohort,observedMergeCount}')::integer from second_summary),
  1, 'the current cohort counts one canonical PR despite many attempts and a prior merge');
select is((select (result #>> '{costs,delivery,knownCostUsd}')::numeric from second_summary),
  14::numeric, 'delivery costs include exact usage and lifetime detached retry/cancel spend only for this PR');
select ok((select (result #>> '{costs,delivery,measuredAttempts}')::int = 3
  and (result #>> '{costs,delivery,estimatedAttempts}')::int = 1
  and (result #>> '{costs,delivery,unavailableAttempts}')::int = 1
  and (result #>> '{costs,delivery,pendingAttempts}')::int = 1
  and (result #>> '{costs,delivery,unresolvedAttributionAttempts}')::int = 1
  and result #>> '{costs,delivery,ratioState}' = 'partial'
  from second_summary), 'measurement, pending coverage and unresolved attribution remain visible beside the partial ratio');
select is((select (result #>> '{costs,operating,knownCostUsd}')::numeric from second_summary),
  22::numeric, 'period operating cost includes abandoned and post-delivery work but excludes pre-period usage');
select ok((select (result #>> '{costs,operating,unlinkedAttempts}')::int = 2
  and (result #>> '{costs,operating,pendingAttempts}')::int = 1
  and (result #>> '{costs,operating,unavailableAttempts}')::int = 1 from second_summary),
  'operating costs disclose unlinked work and pending or unmeasured costs');
select is((select jsonb_array_length(result->'unavailableCostCategories') from second_summary),
  4, 'unmetered evaluation, experiment, maintenance and compute categories stay explicit');

create temp table second_contributions as
select contribution.* from cost_clock
cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
  period_from, period_to, 'delivery') contribution;
select results_eq($q$
  select run_id, attribution, cost_state, cost_usd from second_contributions
  order by run_id
$q$, $q$
  select run_id, attribution, cost_state, cost_usd from (
    select run_id, 'exact_publication_receipt'::text attribution, 'measured'::text cost_state, 7::numeric cost_usd
    from successor_run
    union all select pg_temp.cost_id(32), 'settled_session_window', 'estimated', 3::numeric
    union all select pg_temp.cost_id(33), 'settled_session_window', 'measured', 4::numeric
    union all select pg_temp.cost_id(34), 'settled_session_window', 'unavailable', null::numeric
    union all select pg_temp.cost_id(36), 'unresolved', 'pending', null::numeric
    union all select pg_temp.cost_id(37), 'settled_session_window', 'measured', 0::numeric
  ) expected order by run_id
$q$, 'exact contributor rows reconcile to retained usage and never charge unresolved active work');
select is((select count(*) from second_contributions contribution
  join internal.current_factory_canonical_pull_request_merges merge on merge.id = contribution.merge_id
  where merge.epoch_id = (select epoch_id from second_epoch) and merge.observation_id = contribution.merge_observation_id),
  5::bigint, 'each included delivery attempt carries its exact canonical merge and observation IDs');

select is((pg_temp.cost_summary(now() - interval '56 hours', now() - interval '40 hours')
  #>> '{costs,delivery,knownCostUsd}')::numeric, 28::numeric,
  'selecting the earlier cohort keeps its own exact and failed attempt spend without charging a merge-crossing attempt');
select ok((select first_page.run_id < second_page.run_id
  from cost_clock cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, 'delivery', p_limit => 1) first_page
  cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, 'delivery', p_after_run_id => first_page.run_id, p_limit => 1) second_page),
  'contribution cursors page exact rows without repeating or changing their accounting basis');
select ok((select sum(facts.cost_usd) = (pg_temp.cost_summary(period_from, period_to)
    #>> '{costs,delivery,knownCostUsd}')::numeric
  and bool_and(facts.merge_id is not null and facts.cost_state in ('measured', 'estimated'))
  from cost_clock cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, 'delivery', p_facet => 'known') facts group by period_from, period_to),
  'known delivery-cost evidence exactly reproduces the included summary numerator');
select ok((select facts.cost_state = 'estimated' and facts.run_id = pg_temp.cost_id(32)
  from cost_clock cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, 'delivery', p_limit => 1, p_facet => 'estimated') facts),
  'estimated delivery cost selects only included estimated attempts');
select ok((select facts.cost_state = 'pending' and facts.attribution = 'unresolved'
  from cost_clock cross join lateral public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, 'delivery', p_limit => 1, p_facet => 'pending') facts),
  'pending coverage includes unresolved delivery attribution to match its aggregate');
select ok((select jsonb_array_length(evidence->'items') = (pg_temp.cost_summary(period_from, period_to)
    #>> '{mergeCohort,observedMergeCount}')::integer
  and evidence #>> '{items,0,mergeObservationId}' = merge.observation_id::text and evidence->'nextCursor' = 'null'::jsonb
  from cost_clock cross join second_epoch
  join internal.current_factory_canonical_pull_request_merges merge on merge.epoch_id = second_epoch.epoch_id
  cross join lateral public.list_factory_cost_merges(pg_temp.cost_id(2), pg_temp.cost_factory(),
    period_from, period_to, p_limit => 1) evidence),
  'cost ratio denominator evidence matches exact canonical observation membership');
select throws_ok($$select public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
  now() - interval '1 day', now(), 'delivery', p_facet => 'unrecognized')$$,
  '22023', null, 'cost evidence rejects unsupported facets');

select ok((with sample as (
  select pg_temp.cost_summary(now() + interval '1 hour', now() + interval '4 hours') value
) select (value #>> '{costs,operating,knownCostUsd}')::numeric = 6
  and value #>> '{costs,operating,knownCostPerObservedMergeUsd}' is null
  and value #>> '{costs,operating,ratioState}' = 'no_observed_merges' from sample),
  'a period with real spend and no observed merges has a null ratio');
select ok((with sample as (
  select pg_temp.cost_summary(now() - interval '10 hours', now() - interval '7 hours') value
) select value #>> '{costs,operating,knownCostUsd}' is null
  and value #>> '{costs,operating,costState}' = 'unavailable' from sample),
  'an all-unavailable usage group has no numeric subtotal');
select is((pg_temp.cost_summary(now() - interval '5 hours 30 minutes', now() - interval '4 hours')
  #>> '{costs,operating,knownCostUsd}')::numeric, 0::numeric, 'an explicit measured zero remains a known value');

select ok((select pg_temp.observe_cost_merge(epoch_id, 59402, merged_at, merged_at, repeat('d', 40), repeat('c', 40))
  from second_epoch cross join second_merge_time), 'conflicting same-timestamp provider evidence is retained');
select ok((select (value #>> '{mergeCohort,observedMergeCount}')::int = 0
  and (value #>> '{mergeCohort,unresolvedMergeCount}')::int = 1
  and value #>> '{costs,delivery,knownCostPerObservedMergeUsd}' is null
  from cost_clock cross join lateral pg_temp.cost_summary(period_from, period_to) sample(value)),
  'an unresolved merge contributes neither a denominator nor a cost-per-merge value');
select ok((select pg_temp.observe_cost_merge(epoch_id, 59402, merged_at, merged_at + interval '1 second',
  repeat('f', 40), repeat('c', 40)) from second_epoch cross join second_merge_time),
  'a later exact provider correction resolves the ambiguous merge');
select is((select (pg_temp.cost_summary(period_from, period_to) #>> '{costs,delivery,knownCostUsd}')::numeric from cost_clock),
  14::numeric, 'correction rebuilds current membership without double counting prior merge observations');

select throws_ok($q$select pg_temp.cost_summary(now() - interval '367 days', now())$q$, '22023', null,
  'cost periods are bounded');
select throws_ok($q$select public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
  now() - interval '1 day', now(), 'delivery', p_limit => 251)$q$, '22023', null, 'drilldown pages are bounded');
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59400000-0000-4000-8000-000000000099';
select throws_ok($q$select pg_temp.cost_summary(now() - interval '1 day', now())$q$, '42501', null,
  'another tenant cannot read aggregate costs');
select throws_ok($q$select public.list_factory_cost_contributions(pg_temp.cost_id(2), pg_temp.cost_factory(),
  now() - interval '1 day', now(), 'delivery')$q$, '42501', null, 'contribution IDs are protected by the same factory fence');
set local request.jwt.claim.sub = '59400000-0000-4000-8000-000000000098';
select throws_ok($q$select public.get_factory_cost_summary(pg_temp.cost_id(2), (select id from sibling_factory),
  now() - interval '1 day', now())$q$, '42501', null, 'workspace membership does not expose a restricted factory');
set local request.jwt.claim.sub = '59400000-0000-4000-8000-000000000001';
select ok(pg_temp.cost_summary(now() - interval '1 day', now() + interval '1 day') is not null,
  'the active owner can read their factory costs');

select * from finish();
rollback;
