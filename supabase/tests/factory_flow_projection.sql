begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

create function pg_temp.flow_id(slot integer) returns uuid language sql immutable as $$
  select ('59300000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;
create function pg_temp.flow_time(seconds integer) returns timestamptz language sql immutable as $$
  select '2026-01-02T00:00:00Z'::timestamptz + make_interval(secs => seconds)
$$;
create function pg_temp.flow_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.flow_id(4) and is_default
$$;

-- Make the provider/worker cutovers deterministic. All source times in this
-- fixture remain in the past, even on a freshly initialized database.
update internal.factory_outcome_capture_coverage set live_from = pg_temp.flow_time(-3600)
where source in ('lifecycle', 'pull_requests', 'deployments');

do $$
declare batch jsonb;
begin
  for attempt in 1..20 loop
    batch := public.process_factory_flow_projection(50);
    if not (batch->>'hasMore')::boolean then return; end if;
  end loop;
  raise exception 'Could not drain the local seed projection queue.';
end;
$$;

insert into auth.users(id, email) values
  (pg_temp.flow_id(1), 'flow-projection-owner@example.test'),
  (pg_temp.flow_id(2), 'flow-projection-member@example.test');
insert into public.workspaces(id, slug, name) values
  (pg_temp.flow_id(4), 'flow-projection-fixture', 'Flow projections');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.flow_id(11), pg_temp.flow_id(4), pg_temp.flow_id(1), 'human', 'owner'),
  (pg_temp.flow_id(12), pg_temp.flow_id(4), pg_temp.flow_id(2), 'human', 'member');
select public.grant_factory_membership(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), pg_temp.flow_id(12), 'member');
select public.create_factory(pg_temp.flow_id(4), pg_temp.flow_id(1), 'Other flow factory', 'other-flow');
create temp table flow_scopes as
select pg_temp.flow_factory() as included,
  (select id from public.factories where workspace_id = pg_temp.flow_id(4) and slug = 'other-flow') as excluded;
grant select on flow_scopes to authenticated;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
values (pg_temp.flow_id(20), pg_temp.flow_id(4), pg_temp.flow_factory(), 'Projection fixture', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md)
values (pg_temp.flow_id(21), pg_temp.flow_id(20), pg_temp.flow_id(4), 1, 'review', 'Review', 'Review the change.');
insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
values (pg_temp.flow_id(100), pg_temp.flow_id(4), pg_temp.flow_factory(), 100, 'Observed timeline',
  pg_temp.flow_id(11), pg_temp.flow_id(20), pg_temp.flow_id(21), pg_temp.flow_time(0));
alter table public.sessions disable trigger capture_factory_outcome_session_created;
insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
values (pg_temp.flow_id(101), pg_temp.flow_id(4), pg_temp.flow_factory(), 101, 'Partial retained timeline',
  pg_temp.flow_id(11), pg_temp.flow_id(20), pg_temp.flow_id(21), pg_temp.flow_time(0));
alter table public.sessions enable trigger capture_factory_outcome_session_created;

create function pg_temp.observe_flow(
  p_type text, p_kind text, p_anchor_slot integer, p_offset integer,
  p_session_slot integer default 100, p_job_slot integer default null, p_run_slot integer default null,
  p_attempt integer default null, p_artifact_slot integer default null, p_status text default null
) returns void language sql as $$
  select internal.record_factory_outcome_observation(
    session.workspace_id, session.factory_id, p_type, p_kind,
    pg_temp.flow_id(p_anchor_slot)::text || case
      when p_kind in ('job', 'run') then ':' || coalesce(p_attempt, 0)::text
      else '' end,
    pg_temp.flow_time(p_offset),
    p_session_id => session.id, p_job_id => pg_temp.flow_id(p_job_slot), p_run_id => pg_temp.flow_id(p_run_slot),
    p_attempt_count => p_attempt, p_stage_id => session.current_stage_id,
    p_artifact_id => pg_temp.flow_id(p_artifact_slot), p_status => p_status
  ) from public.sessions session where session.id = pg_temp.flow_id(p_session_slot)
$$;

select pg_temp.observe_flow('job.queued', 'job', 201, 10, p_job_slot => 201, p_attempt => 1, p_status => 'queued');
select pg_temp.observe_flow('run.started', 'run', 301, 20, p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_status => 'running');
select pg_temp.observe_flow('review.ready', 'artifact', 401, 40,
  p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_artifact_slot => 401, p_status => 'awaiting_review');
select pg_temp.observe_flow('run.finished', 'run', 301, 50,
  p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_status => 'success');
select pg_temp.observe_flow('review.clarification_requested', 'clarification', 501, 60,
  p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_artifact_slot => 401);
select pg_temp.observe_flow('review.ready', 'artifact', 401, 70,
  p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_artifact_slot => 401, p_status => 'awaiting_review');
select pg_temp.observe_flow('review.clarification_answered', 'clarification', 501, 80,
  p_job_slot => 201, p_run_slot => 301, p_attempt => 1, p_artifact_slot => 401);
select pg_temp.observe_flow('review.approved', 'approval_receipt', 601, 90,
  p_artifact_slot => 401, p_status => 'in_progress');
select pg_temp.observe_flow('job.queued', 'job', 202, 100, p_job_slot => 202, p_attempt => 1, p_status => 'queued');
select pg_temp.observe_flow('job.finished', 'job', 202, 130, p_job_slot => 202, p_attempt => 1, p_status => 'canceled');

-- An older historical attempt has an observed beginning, but only a different
-- attempt has a terminal fact. It cannot manufacture a duration or request.
select pg_temp.observe_flow('run.started', 'run', 302, 20, p_session_slot => 101,
  p_job_slot => 203, p_run_slot => 302, p_attempt => 1, p_status => 'running');
select pg_temp.observe_flow('run.finished', 'run', 302, 35, p_session_slot => 101,
  p_job_slot => 203, p_run_slot => 302, p_attempt => 2, p_status => 'error');

select public.process_factory_flow_projection(25);
select is((select requested_at from internal.factory_flow_projection_sessions where session_id = pg_temp.flow_id(100)),
  pg_temp.flow_time(0), 'projection preserves the exact observed request time');
select ok((select projected.request_observation_id = fact.id
  from internal.factory_flow_projection_sessions projected
  join internal.factory_outcome_observations fact on fact.session_id = projected.session_id and fact.event_type = 'session.created'
  where projected.session_id = pg_temp.flow_id(100)), 'request provenance retains the actual observation ID');
select results_eq(
  $$select phase, sum(extract(epoch from ended_at - started_at))::integer as seconds
    from internal.factory_flow_projection_segments where session_id = pg_temp.flow_id(100) group by phase order by phase$$,
  $$values ('active'::text, 30), ('blocked'::text, 20), ('queued'::text, 40), ('review'::text, 20), ('unknown'::text, 20)$$,
  'active and blocked intervals take precedence during overlapping review, and the canceled queue closes');
select ok(not exists (
  select 1 from (
    select started_at, ended_at, lag(ended_at) over (order by started_at, ended_at, phase) as prior_end
    from internal.factory_flow_projection_segments where session_id = pg_temp.flow_id(100)
  ) segments where started_at >= ended_at or started_at < prior_end
), 'known and unknown segments are positive and disjoint');
select ok((select active.observation_ids @> (
    select array_agg(fact.id)
    from internal.factory_outcome_observations fact where fact.session_id = pg_temp.flow_id(100)
      and fact.run_id = pg_temp.flow_id(301) and fact.event_type in ('run.started', 'run.finished')
  )
  from internal.factory_flow_projection_segments active
  where active.session_id = pg_temp.flow_id(100) and active.phase = 'active'
    and active.started_at <= pg_temp.flow_time(20) and active.ended_at > pg_temp.flow_time(20)),
  'active interval keeps both exact run-boundary observation IDs');
select ok((select requested_at is null and request_observation_id is null and 'active' = any(open_phases)
  from internal.factory_flow_projection_sessions where session_id = pg_temp.flow_id(101)),
  'partial history retains a known open phase and unknown request identity');
select ok(not exists (select 1 from internal.factory_flow_projection_segments
  where session_id = pg_temp.flow_id(101) and phase = 'active'),
  'a different attempt cannot close the open run or contribute an active duration');

-- A late terminal arrives before its older start. The existing queue end and
-- unrelated artifacts cannot override the correct exact-attempt boundaries.
select pg_temp.observe_flow('run.finished', 'run', 303, 125,
  p_job_slot => 202, p_run_slot => 303, p_attempt => 1, p_status => 'error');
select pg_temp.observe_flow('run.started', 'run', 303, 115,
  p_job_slot => 202, p_run_slot => 303, p_attempt => 1, p_status => 'running');
select pg_temp.observe_flow('run.finished', 'run', 303, 128,
  p_job_slot => 202, p_run_slot => 303, p_attempt => 1, p_status => 'error');
select public.process_factory_flow_projection(25);
select results_eq(
  $$select phase, sum(extract(epoch from ended_at - started_at))::integer as seconds
    from internal.factory_flow_projection_segments where session_id = pg_temp.flow_id(100) group by phase order by phase$$,
  $$values ('active'::text, 40), ('blocked'::text, 20), ('queued'::text, 25), ('review'::text, 20), ('unknown'::text, 25)$$,
  'incremental refresh reconciles reversed arrival with nonduplicated source durations');
select is((select max(ended_at) from internal.factory_flow_projection_segments where session_id = pg_temp.flow_id(100)),
  pg_temp.flow_time(130), 'late arrival preserves the source-time observation horizon');
select is((select last_observation_at from internal.factory_flow_projection_sessions where session_id = pg_temp.flow_id(100)),
  (select max(observed_at) from internal.factory_outcome_observations where session_id = pg_temp.flow_id(100)),
  'projection freshness carries receipt time independently of the source-time horizon');

create temp table flow_incremental_sessions as
select session_id, requested_at, request_observation_id, last_observation_at, open_phases
from internal.factory_flow_projection_sessions where workspace_id = pg_temp.flow_id(4);
create temp table flow_incremental_segments as
select session_id, phase, started_at, ended_at, observation_ids
from internal.factory_flow_projection_segments where workspace_id = pg_temp.flow_id(4);
select is((public.enqueue_factory_flow_rebuild(pg_temp.flow_id(4), pg_temp.flow_factory(), p_limit => 1)->>'nextSessionId')::uuid,
  pg_temp.flow_id(100), 'rebuild returns the first scoped session as its continuation');
select is((public.enqueue_factory_flow_rebuild(pg_temp.flow_id(4), pg_temp.flow_factory(), pg_temp.flow_id(100), 1)->>'nextSessionId')::uuid,
  pg_temp.flow_id(101), 'rebuild continuation reaches the remaining scoped session');
select public.process_factory_flow_projection(25);
select results_eq(
  $$select session_id, requested_at, request_observation_id, last_observation_at, open_phases
    from internal.factory_flow_projection_sessions where workspace_id = pg_temp.flow_id(4) order by session_id$$,
  $$select * from flow_incremental_sessions order by session_id$$,
  'keyset rebuild reproduces the incremental horizon, provenance and open states');
select results_eq(
  $$select session_id, phase, started_at, ended_at, observation_ids
    from internal.factory_flow_projection_segments where workspace_id = pg_temp.flow_id(4)
    order by session_id, started_at, ended_at, phase$$,
  $$select * from flow_incremental_segments order by session_id, started_at, ended_at, phase$$,
  'scoped rebuild reproduces the exact segments and their contributing observations');

select ok(not has_function_privilege('authenticated', 'public.process_factory_flow_projection(integer)', 'execute')
  and not has_table_privilege('authenticated', 'internal.factory_flow_projection_segments', 'select'),
  'maintenance and raw projection rows are private');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59300000-0000-4000-8000-000000000002';
select throws_ok($$select public.get_factory_flow_summary(pg_temp.flow_id(4), excluded, pg_temp.flow_time(0), pg_temp.flow_time(200))
  from flow_scopes$$, 'PT404', null, 'a factory member cannot read a sibling factory cohort');
select throws_ok($$select public.list_factory_flow_evidence(pg_temp.flow_id(4), excluded,
  pg_temp.flow_time(0), pg_temp.flow_time(200), 'workflow_flow') from flow_scopes$$,
  'PT404', null, 'sibling factory evidence remains inaccessible to the member');
select throws_ok($$select public.enqueue_factory_flow_rebuild(pg_temp.flow_id(4), included) from flow_scopes$$,
  'PT404', null, 'ordinary factory access does not permit requesting a rebuild');
create temp table flow_summary as
select public.get_factory_flow_summary(pg_temp.flow_id(4), included, pg_temp.flow_time(0), pg_temp.flow_time(200)) result
from flow_scopes;
select ok((select (result #>> '{merge,censored}')::integer >= 1
  and (result #>> '{merge,measured}')::integer = 0 and result #> '{merge,distribution}' = 'null'::jsonb
  from flow_summary), 'known requests with no authoritative merge are censored with no zero-duration distribution');
select ok((select (result #>> '{deployment,measured}')::integer = 0
  and result #> '{deployment,distribution}' = 'null'::jsonb from flow_summary),
  'separate deployment duration stays unknown or censored when no linked success exists');
select ok((select (result #>> '{coverage,unplacedSessions}')::integer >= 1 from flow_summary),
  'cohort coverage exposes sessions whose request could not be placed');
select ok((select jsonb_array_length(result->'items') = 1 and result->'nextCursor' <> 'null'::jsonb
  from (select public.list_factory_flow_evidence(pg_temp.flow_id(4), included,
    pg_temp.flow_time(0), pg_temp.flow_time(200), 'workflow_flow', p_limit => 1) result from flow_scopes) page),
  'authorized workflow drilldown returns a bounded page with a continuation cursor');
select ok((select jsonb_array_length(result->'items') = 1
  and result #>> '{items,0,phase}' = 'active'
  and (select bool_and(fact->>'runId' = pg_temp.flow_id(301)::text)
    and jsonb_agg(fact->'id' order by fact->>'id') = result #> '{items,0,observationIds}'
    from jsonb_array_elements(result #> '{items,0,observations}') fact)
  from (select public.list_factory_flow_evidence(pg_temp.flow_id(4), included,
    pg_temp.flow_time(0), pg_temp.flow_time(200), 'workflow_flow', p_limit => 1, p_facet => 'active') result
    from flow_scopes) page),
  'active duration applies its facet before the page limit and admits only the exact retained source facts');
select throws_ok($$select public.list_factory_flow_evidence(pg_temp.flow_id(4), included,
  pg_temp.flow_time(0), pg_temp.flow_time(200), 'workflow_flow', p_facet => 'measured') from flow_scopes$$,
  '22023', null, 'flow evidence refuses a duration status as a phase filter');

select ok((select (result #>> '{flow,unknown,seconds}')::numeric = 5
  and (result #>> '{flow,queued,seconds}')::numeric = 5
  from (select public.get_factory_flow_summary(pg_temp.flow_id(4), included,
    pg_temp.flow_time(5), pg_temp.flow_time(15)) result from flow_scopes) clip),
  'a report window clips segment contributions at both boundaries');
set local request.jwt.claim.sub = '59300000-0000-4000-8000-000000000001';
select throws_ok($$select public.get_factory_flow_summary(pg_temp.flow_id(4), pg_temp.flow_id(999),
  pg_temp.flow_time(0), pg_temp.flow_time(200))$$, 'PT404', null,
  'a workspace owner cannot resolve a nonexistent factory in their own workspace');
set local request.jwt.claim.sub = '59300000-0000-4000-8000-000000000002';

reset role;
set local request.jwt.claim.role = 'service_role';

-- Build one positive cohort with the production merge and report authorities.
-- The policy approval and archive are separate from authoritative delivery.
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.flow_id(30), pg_temp.flow_id(4), 59300001, 'https://github.test/installations/59300001',
  59300, 'Organization', 'flow-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id,
  name, full_name, private, html_url, default_branch)
values (pg_temp.flow_id(31), pg_temp.flow_id(4), pg_temp.flow_factory(), pg_temp.flow_id(30), 593001,
  'flow', 'fixture/flow', true, 'https://github.test/fixture/flow', 'main');
insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id,
  current_stage_id, github_repository_id, created_at)
values (pg_temp.flow_id(102), pg_temp.flow_id(4), pg_temp.flow_factory(), 102, 'Measured delivery',
  pg_temp.flow_id(11), pg_temp.flow_id(20), pg_temp.flow_id(21), pg_temp.flow_id(31), pg_temp.flow_time(140));
select pg_temp.observe_flow('review.ready', 'artifact', 402, 150,
  p_session_slot => 102, p_artifact_slot => 402, p_status => 'awaiting_review');
select pg_temp.observe_flow('review.approved', 'approval_receipt', 602, 160,
  p_session_slot => 102, p_artifact_slot => 402, p_status => 'approved');
update public.sessions set archived_at = pg_temp.flow_time(170) where id = pg_temp.flow_id(102);

insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
values (pg_temp.flow_id(102), pg_temp.flow_id(4), pg_temp.flow_id(31), 'fixture/flow', 'main', repeat('a', 40));
insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
  github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha)
values(pg_temp.flow_id(710), pg_temp.flow_id(102), pg_temp.flow_id(4), 1, pg_temp.flow_id(31), 'fixture/flow',
  593001, 'main', 'wallie/sessions/' || pg_temp.flow_id(102)::text || '/' || pg_temp.flow_id(710)::text,
  'refs/wallie/fences/' || pg_temp.flow_id(710)::text, 1, 'https://github.test/fixture/flow/pull/1', 'open', false, repeat('b', 40));
select public.process_factory_flow_projection(25);
select ok((select 'delivery' = any(open_phases) from internal.factory_flow_projection_sessions where session_id = pg_temp.flow_id(102))
  and not exists (select 1 from internal.factory_flow_projection_segments where session_id = pg_temp.flow_id(102) and phase = 'delivery'),
  'final approval opens delivery wait and archive leaves its elapsed time unresolved');
select ok((select public.finish_session_pr_observation_with_merge(
  public.begin_session_pr_observation(workspace_id, repository_id, branch_name, pr_number),
  pr_url, 'merged', false, repeat('b', 40), pg_temp.flow_time(176), pg_temp.flow_time(175),
  repeat('c', 40), repeat('b', 40))
  from public.session_pr_epochs where id = pg_temp.flow_id(710)), 'the canonical observer commits the exact source merge');
select pg_temp.observe_flow('review.approved', 'approval_receipt', 603, 182,
  p_session_slot => 102, p_artifact_slot => 403, p_status => 'approved');

create temp table flow_execution_policy as select * from public.save_execution_policy(
  pg_temp.flow_id(4), pg_temp.flow_id(1), 0,
  '{"version":1,"maxRepairAttempts":2,"maxExecutionMs":30000,"maxTotalTokens":1000,"maxCostUsd":1}');
select public.create_service_principal(pg_temp.flow_id(4), pg_temp.flow_factory(), pg_temp.flow_id(1), 'Flow reporter', 'flow-reporter');
create temp table flow_reporter_grant as
select approved.* from public.service_principals principal cross join flow_execution_policy policy
cross join lateral public.approve_factory_execution_grant(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), principal.id, pg_temp.flow_id(31), '{}', '{}', policy.id, pg_temp.flow_id(11),
  clock_timestamp() + interval '1 hour', 0, null, '{deployments:observe}') approved
where principal.workspace_id = pg_temp.flow_id(4) and principal.slug = 'flow-reporter';
create temp table flow_reporter_source as
select (public.approve_factory_deployment_source(workspace_id, factory_id, pg_temp.flow_id(1), id, version,
  'flow-provider', 'flow-project', 'production', true) ->> 'sourceId')::uuid id from flow_reporter_grant;
select public.issue_factory_machine_token(workspace_id, factory_id, pg_temp.flow_id(1), id, version,
  pg_temp.flow_id(32), repeat('a', 64), 'Flow observer token', '{deployments:observe}') from flow_reporter_grant;
create temp table flow_reporter_permit as select *
from public.admit_factory_command(pg_temp.flow_id(4), pg_temp.flow_factory(), 'machine_token',
  pg_temp.flow_id(32), repeat('a', 64), 'deployments:observe', pg_temp.flow_id(33), repeat('b', 64), 'api');
create temp table flow_reporter_receipt as
select public.execute_factory_deployment_observation(pg_temp.flow_id(4), pg_temp.flow_factory(), 'machine_token',
  pg_temp.flow_id(32), repeat('a', 64), pg_temp.flow_id(33), repeat('b', 64), 'api', permit.admission_id,
  permit.lease_id, source.id, 'production', 'deploy-flow', 1, 'succeeded', repeat('c', 40), pg_temp.flow_time(190)) result
from flow_reporter_permit permit cross join flow_reporter_source source;
select public.release_factory_command_admission(admission_id, lease_id) from flow_reporter_permit;

select public.process_factory_flow_projection(25);
select ok((select not ('delivery' = any(open_phases)) from internal.factory_flow_projection_sessions
  where session_id = pg_temp.flow_id(102)), 'final approval after an already verified merge does not reopen delivery wait');
create temp table flow_expected_measurement as
select fact.id as request_id, merge.observation_id as merge_id, (receipt.result->>'observationId')::uuid as deployment_id
from internal.factory_outcome_observations fact
join internal.current_factory_canonical_pull_request_merges merge on merge.session_id = fact.session_id
cross join flow_reporter_receipt receipt
where fact.event_type = 'session.created' and fact.session_id = pg_temp.flow_id(102);
grant select on flow_expected_measurement to authenticated;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select (result #>> '{merge,measured}')::integer = 1
  and (result #>> '{merge,distribution,p50Seconds}')::numeric = 35
  and (result #>> '{deployment,measured}')::integer = 1
  and (result #>> '{deployment,distribution,p50Seconds}')::numeric = 50
  and (result #>> '{flow,delivery,seconds}')::numeric = 15
  from (select public.get_factory_flow_summary(pg_temp.flow_id(4), included,
    pg_temp.flow_time(140), pg_temp.flow_time(200), 'production') result from flow_scopes) metrics),
  'merge and deploy lead times use their own authoritative provider clocks and count approval-to-merge wait separately');
select ok((select (result #>> '{deployment,measured}')::integer = 0
  and result #> '{deployment,distribution}' = 'null'::jsonb
  from (select public.get_factory_flow_summary(pg_temp.flow_id(4), included,
    pg_temp.flow_time(140), pg_temp.flow_time(200), 'preview') result from flow_scopes) metrics),
  'cohort filtering cannot use a different deployment environment');
select results_eq(
  $$select (item->>'requestObservationId')::uuid, (item->>'mergeObservationId')::uuid, (item->>'deploymentObservationId')::uuid
    from flow_scopes cross join lateral jsonb_array_elements(public.list_factory_flow_evidence(pg_temp.flow_id(4), included,
      pg_temp.flow_time(140), pg_temp.flow_time(200), 'request_to_deployment', 'production')->'items') item$$,
  $$select request_id, merge_id, deployment_id from flow_expected_measurement$$,
  'deployment drilldown retains the exact request, canonical merge and deployment receipts');
select ok((select jsonb_array_length(result->'items') = 1
  and result #>> '{items,0,sessionId}' = pg_temp.flow_id(102)::text
  and result #>> '{items,0,status}' = 'measured' and result->'nextCursor' = 'null'::jsonb
  from (select public.list_factory_flow_evidence(pg_temp.flow_id(4), included,
    pg_temp.flow_time(0), pg_temp.flow_time(200), 'request_to_deployment', 'production', p_limit => 1,
    p_facet => 'measured') result from flow_scopes) page),
  'the delivery percentile cohort skips earlier unmeasured rows before pagination');

reset role;
set local request.jwt.claim.role = 'service_role';

insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id,
  github_repository_id, created_at)
values (pg_temp.flow_id(103), pg_temp.flow_id(4), pg_temp.flow_factory(), 103, 'Deferred queue cancellation',
  pg_temp.flow_id(11), pg_temp.flow_id(20), pg_temp.flow_id(21), pg_temp.flow_id(31), pg_temp.flow_time(210));
select pg_temp.observe_flow('job.queued', 'job', 204, 220, p_session_slot => 103,
  p_job_slot => 204, p_attempt => 1, p_status => 'queued');
select pg_temp.observe_flow('job.queued', 'job', 204, 230, p_session_slot => 103,
  p_job_slot => 204, p_attempt => 2, p_status => 'queued');
select pg_temp.observe_flow('job.finished', 'job', 204, 245, p_session_slot => 103,
  p_job_slot => 204, p_attempt => 1, p_status => 'canceled');
select public.process_factory_flow_projection(25);
select results_eq(
  $$select started_at, ended_at from internal.factory_flow_projection_segments
    where session_id = pg_temp.flow_id(103) and phase = 'queued' order by started_at$$,
  $$values (pg_temp.flow_time(220), pg_temp.flow_time(230)), (pg_temp.flow_time(230), pg_temp.flow_time(245))$$,
  'the next runless queue generation closes the previous wait and cancellation closes the unclaimed retry');
select ok((select not ('queued' = any(open_phases))
  from internal.factory_flow_projection_sessions where session_id = pg_temp.flow_id(103))
  and not exists (select 1 from internal.factory_flow_projection_segments
    where session_id = pg_temp.flow_id(103) and phase = 'active'),
  'canceling before the next claim leaves no open queue or fabricated active duration');

insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
values (pg_temp.flow_id(103), pg_temp.flow_id(4), pg_temp.flow_id(31), 'fixture/flow', 'main', repeat('a', 40));
insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
  github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha)
values (pg_temp.flow_id(711), pg_temp.flow_id(103), pg_temp.flow_id(4), 1, pg_temp.flow_id(31), 'fixture/flow',
  593001, 'main', 'wallie/sessions/' || pg_temp.flow_id(103)::text || '/' || pg_temp.flow_id(711)::text,
  'refs/wallie/fences/' || pg_temp.flow_id(711)::text, 2, 'https://github.test/fixture/flow/pull/2', 'open', false, repeat('e', 40));
select public.finish_session_pr_observation(
  public.begin_session_pr_observation(workspace_id, repository_id, branch_name, pr_number),
  pr_url, 'merged', false, repeat('e', 40), pg_temp.flow_time(249))
from public.session_pr_epochs where id = pg_temp.flow_id(711);
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select (result #>> '{merge,unknown}')::integer = 1 and (result #>> '{merge,censored}')::integer = 0
  and (result #>> '{deployment,unknown}')::integer = 1 and (result #>> '{deployment,censored}')::integer = 0
  from (select public.get_factory_flow_summary(pg_temp.flow_id(4), included,
    pg_temp.flow_time(210), pg_temp.flow_time(250)) result from flow_scopes) metrics),
  'known terminal merge state with no exact endpoint leaves merge and deploy timing unknown');

reset role;
set local request.jwt.claim.role = 'service_role';
insert into auth.sessions(id, user_id, not_after) values
  (pg_temp.flow_id(751), pg_temp.flow_id(1), null),
  (pg_temp.flow_id(752), pg_temp.flow_id(2), null),
  (pg_temp.flow_id(753), pg_temp.flow_id(2), statement_timestamp() - interval '1 second');
select ok(not has_table_privilege('authenticated', 'internal.factory_analytics_exports', 'select')
  and not has_function_privilege('service_role', 'public.read_factory_analytics_export(uuid,uuid,uuid)', 'execute')
  and not has_function_privilege('authenticated', 'public.prune_factory_analytics_exports(integer)', 'execute'),
  'analytics snapshots are reachable only through live authenticated and bounded retention RPCs');

create function pg_temp.request_flow_export(p_request integer, p_environment text default 'production', p_factory uuid default null)
returns jsonb language sql as $$
  select public.create_factory_analytics_export(pg_temp.flow_id(4),
    coalesce(p_factory, (select included from flow_scopes)), pg_temp.flow_time(0), pg_temp.flow_time(86400),
    pg_temp.flow_id(p_request), 'source', p_environment, true)
$$;
create function pg_temp.switch_export_viewer(p_user integer, p_auth_session integer) returns void language sql as $$
  select set_config('request.jwt.claim.sub', pg_temp.flow_id(p_user)::text, true);
  select set_config('request.jwt.claims', jsonb_build_object(
    'sub', pg_temp.flow_id(p_user), 'role', 'authenticated', 'session_id', pg_temp.flow_id(p_auth_session))::text, true);
$$;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select pg_temp.switch_export_viewer(2, 752);
create temp table flow_export_receipt as select pg_temp.request_flow_export(760) receipt;
create temp table flow_export_frozen as
select public.read_factory_analytics_export(pg_temp.flow_id(4), included, (receipt->>'id')::uuid) raw
from flow_scopes cross join flow_export_receipt;
select ok((select raw::jsonb #>> '{filters,dimension}' = 'source'
  and raw::jsonb #>> '{filters,deploymentEnvironment}' = 'production'
  and (raw::jsonb #>> '{filters,comparePrevious}')::boolean
  and raw::jsonb #>> '{periods,0,rolesVisibility}' = 'redacted'
  and (raw::jsonb #>> '{periods,1,window,from}')::timestamptz = pg_temp.flow_time(-86400)
  and (raw::jsonb #>> '{periods,1,window,to}')::timestamptz = pg_temp.flow_time(0)
  and (raw::jsonb->>'expiresAt')::timestamptz = (raw::jsonb->>'capturedAt')::timestamptz + interval '24 hours'
  from flow_export_frozen), 'one short-lived receipt freezes the same UTC filters and complete comparison window');
select ok((select document #> '{periods,0,summaries,flow,flow}' = live->'flow'
  and document #> '{periods,0,summaries,flow,deployment}' = live->'deployment'
  and (document #>> '{periods,0,summaries,throughput,observedMergeCount}')::integer = 1
  and (document #>> '{periods,0,summaries,revert,immatureCount}')::integer = 0
  and (document #>> '{periods,0,summaries,cost,mergeCohort,observedMergeCount}')::integer =
    jsonb_array_length(document #> '{periods,0,evidence,costMerges}')
  and (document #>> '{periods,1,summaries,cost,mergeCohort,observedMergeCount}')::integer = 0
  from flow_export_frozen cross join lateral (select raw::jsonb document) snapshot
  cross join flow_scopes cross join lateral public.get_factory_flow_summary(pg_temp.flow_id(4), included,
    pg_temp.flow_time(0), pg_temp.flow_time(86400), 'production') live),
  'every exported dashboard period retains the same field values and precise cost denominator');
select results_eq(
  $$select (item->>'requestObservationId')::uuid, (item->>'mergeObservationId')::uuid,
      (item->>'deploymentObservationId')::uuid
    from flow_export_frozen cross join lateral jsonb_array_elements(raw::jsonb #> '{periods,0,evidence,deployment}') item
    where item->>'status' = 'measured'$$,
  $$select request_id, merge_id, deployment_id from flow_expected_measurement$$,
  'the frozen measurement points to the same request, merge, and deployment as Analytics evidence');
select is(pg_temp.request_flow_export(760), (select receipt from flow_export_receipt),
  'retrying the same request ID returns the original export receipt');
select throws_ok($$select pg_temp.request_flow_export(760, 'preview')$$, 'PT409', null,
  'a replay cannot substitute different export filters');
select throws_ok($$select pg_temp.request_flow_export(761, p_factory => excluded) from flow_scopes$$,
  'PT404', null, 'a member cannot request a snapshot from a restricted sibling factory');
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), excluded, (receipt->>'id')::uuid) is null
  from flow_scopes cross join flow_export_receipt), 'a snapshot ID does not authorize another factory');
select pg_temp.switch_export_viewer(1, 751);
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), included, (receipt->>'id')::uuid) is null
  from flow_scopes cross join flow_export_receipt), 'a different member cannot download a copied snapshot link');
select pg_temp.switch_export_viewer(2, 753);
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), included, (receipt->>'id')::uuid) is null
  from flow_scopes cross join flow_export_receipt), 'an expired login cannot use an existing download URL');

reset role;
set local request.jwt.claim.role = 'service_role';
select ok((select public.finish_session_pr_observation_with_merge(
  public.begin_session_pr_observation(workspace_id, repository_id, branch_name, pr_number),
  pr_url, 'merged', false, repeat('b', 40), pg_temp.flow_time(181), pg_temp.flow_time(180),
  repeat('d', 40), repeat('b', 40))
  from public.session_pr_epochs where id = pg_temp.flow_id(710)),
  'late canonical correction changes the current timing and detaches the old deployment');
select public.process_factory_flow_projection(50);
select public.grant_factory_membership(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), pg_temp.flow_id(11), 'manager');
select public.grant_factory_membership(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), pg_temp.flow_id(12), 'manager');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select pg_temp.switch_export_viewer(2, 752);
create temp table flow_export_manager as select pg_temp.request_flow_export(762) receipt;
select ok((select corrected::jsonb #>> '{periods,0,rolesVisibility}' = 'full'
  and (corrected::jsonb #>> '{periods,0,summaries,flow,deployment,measured}')::integer = 0
  and (raw::jsonb #>> '{periods,0,summaries,flow,deployment,measured}')::integer = 1
  and raw = public.read_factory_analytics_export(pg_temp.flow_id(4), included, (initial.receipt->>'id')::uuid)
  from flow_scopes cross join flow_export_receipt initial cross join flow_export_frozen
  cross join flow_export_manager cross join lateral public.read_factory_analytics_export(
    pg_temp.flow_id(4), included, (flow_export_manager.receipt->>'id')::uuid) corrected),
  'late observations change a new snapshot while the old download remains byte-identical');

reset role;
set local request.jwt.claim.role = 'service_role';
select public.grant_factory_membership(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), pg_temp.flow_id(12), 'member');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), included, (receipt->>'id')::uuid) is null
  from flow_scopes cross join flow_export_manager),
  'downgraded managers cannot download previously frozen privileged source roles');
select throws_ok($$select pg_temp.request_flow_export(762)$$, 'PT404', null,
  'a replay cannot disclose the manager snapshot after role downgrade');

reset role;
set local request.jwt.claim.role = 'service_role';
insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
select pg_temp.flow_id(1000 + slot), pg_temp.flow_id(4), pg_temp.flow_factory(), 1000 + slot,
  'Bounded export request', pg_temp.flow_id(11), pg_temp.flow_id(20), pg_temp.flow_id(21), pg_temp.flow_time(300 + slot)
from generate_series(1, 101) slot;
do $$
begin
  for batch in 1..20 loop
    if not (public.process_factory_flow_projection(50)->>'hasMore')::boolean then return; end if;
  end loop;
  raise exception 'Could not drain the bounded export projection fixture.';
end;
$$;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select throws_ok($$select pg_temp.request_flow_export(763)$$, 'PT422', null,
  'oversized source evidence rejects the complete export instead of freezing a truncated cohort');

reset role;
set local request.jwt.claim.role = 'service_role';
select ok(not exists (select 1 from internal.factory_analytics_exports where request_id = pg_temp.flow_id(763)),
  'the failed bounded request never saves a partial export');
select public.revoke_factory_membership(pg_temp.flow_id(4), pg_temp.flow_factory(),
  pg_temp.flow_id(1), pg_temp.flow_id(12), 'Remove disposable fixture access');
insert into internal.factory_analytics_exports(
  id, workspace_id, factory_id, requester_member_id, request_id, captured_at, expires_at, requires_manager, filters, payload
) values (pg_temp.flow_id(764), pg_temp.flow_id(4), pg_temp.flow_factory(), pg_temp.flow_id(11), pg_temp.flow_id(765),
  statement_timestamp() - interval '25 hours', statement_timestamp() - interval '1 hour', true, '{}', '{}');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), included, (receipt->>'id')::uuid) is null
  from flow_scopes cross join flow_export_receipt), 'revoking factory membership invalidates old download URLs');
select pg_temp.switch_export_viewer(1, 751);
select ok((select public.read_factory_analytics_export(pg_temp.flow_id(4), included, pg_temp.flow_id(764)) is null
  from flow_scopes), 'expired snapshots are unreadable even before storage cleanup');

reset role;
set local request.jwt.claim.role = 'service_role';
select ok(public.prune_factory_analytics_exports(100) >= 1, 'worker retention claims bounded expired payloads');
select ok(not exists (select 1 from internal.factory_analytics_exports where id = pg_temp.flow_id(764))
  and exists (select 1 from internal.factory_analytics_exports where request_id = pg_temp.flow_id(760)),
  'worker retention purges expired payloads and preserves unexpired frozen snapshots');

select * from finish();
rollback;
