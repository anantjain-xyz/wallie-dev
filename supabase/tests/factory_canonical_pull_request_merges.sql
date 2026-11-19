begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

select public.set_git_continuity_release(true, revision, 'Canonical merge observation fixture')
from public.get_git_continuity_release_state() where not enabled;

insert into internal.workspace_issue_counters as counters(workspace_id, last_issue_number)
select 'b1b2c3d4-0001-4000-8000-000000000001'::uuid, coalesce(max(number), 0)
from public.sessions where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001'
on conflict (workspace_id) do update
set last_issue_number = greatest(counters.last_issue_number, excluded.last_issue_number);

create function pg_temp.publish_merge_fixture(target_job uuid, output_sha text)
returns uuid language plpgsql as $$
declare owner public.sessions; selected public.session_job_git_inputs; started uuid; claim uuid; retained text;
begin
  select s.* into strict owner from public.sessions s join public.agent_jobs j on j.session_id = s.id where j.id = target_job;
  update public.agent_jobs set status = 'running', attempt_count = 1,
    git_continuity_release_revision = (select revision from public.get_git_continuity_release_state())
    where id = target_job;
  started := public.start_session_job_attempt(target_job, 1, owner.current_stage_id, owner.current_artifact_version,
    'codex', 'gpt-5.5', 'project', 'wallie/merge-observation-' || target_job::text);
  select * into selected from public.session_job_git_inputs where job_id = target_job;
  perform public.pin_session_job_git_input(target_job, 1, started,
    owner.github_repository_id, coalesce(selected.base_branch, 'main'), coalesce(selected.input_sha, repeat('a', 40)));
  select * into strict selected from public.session_job_git_inputs where job_id = target_job;
  if not public.prepare_session_source_and_checkpoint_publication(
    started, selected.repository_id, selected.base_branch, selected.input_sha, output_sha,
    'Merge observation checkpoint', 'Canonical publication body', '',
    encode(extensions.digest('merge observation source'::bytea, 'sha256'), 'hex'),
    encode('merge observation source'::bytea, 'base64'),
    owner.current_artifact_version, 'Canonical merge observation artifact'
  ) then raise exception 'Merge observation checkpoint preparation failed.'; end if;
  claim := public.claim_session_checkpoint_publication(started);
  select retained_ref into strict retained from public.session_checkpoint_publications where run_id = started;
  if claim is null or not public.adopt_session_checkpoint_publication(started, claim, retained, output_sha)
    then raise exception 'Merge observation checkpoint adoption failed.'; end if;
  return started;
end;
$$;

create function pg_temp.merge_fixture(label text, output_sha text default repeat('b', 40))
returns uuid language plpgsql as $$
declare created record;
begin
  select * into strict created from public.create_session_with_first_job(
    'b1b2c3d4-0001-4000-8000-000000000001', 'c1b2c3d4-0001-4000-8000-000000000001',
    label, 'Synchronize merge observation source', 'codex', 'gpt-5.5',
    null, null, '12b2c3d4-0001-4000-8000-000000000001', null);
  perform pg_temp.publish_merge_fixture(created.job_id, output_sha);
  return created.session_id;
end;
$$;

create function pg_temp.merge_revision(target_session uuid, output_sha text)
returns uuid language plpgsql as $$
declare owner public.sessions; queued record;
begin
  select * into strict owner from public.sessions where id = target_session;
  select * into strict queued from public.reject_session_stage(owner.id, owner.workspace_id, owner.current_artifact_version,
    'Revise the canonical source', 'codex', 'gpt-5.5', owner.current_stage_id, owner.current_artifact_id, 'project',
    'c1b2c3d4-0001-4000-8000-000000000001');
  return pg_temp.publish_merge_fixture(queued.job_id, output_sha);
end;
$$;

create function pg_temp.merge_claim(target_session uuid)
returns public.session_pr_operations language plpgsql as $$
declare claim uuid; packet public.session_pr_operations;
begin
  claim := public.claim_session_pr_sync(target_session);
  if claim is null then raise exception 'Expected canonical synchronization claim.'; end if;
  select * into strict packet from public.session_pr_operations where claim_id = claim;
  return packet;
end;
$$;

create function pg_temp.merge_url(target_epoch uuid, number integer)
returns text language sql stable as $$
  select 'https://github.com/' || repository_full_name || '/pull/' || number::text
  from public.session_pr_epochs where id = target_epoch
$$;

create function pg_temp.reserve_merge_sync(operation public.session_pr_operations, number integer)
returns uuid language plpgsql as $$
declare observation uuid;
begin
  if not exists(select 1 from public.session_pr_epochs where id = operation.epoch_id and pr_number is not null)
    and not public.arm_session_pr_creation(operation.epoch_id, operation.id, operation.claim_id) then
    raise exception 'Expected the initial canonical PR creation to be armed.';
  end if;
  observation := public.begin_session_pr_sync_observation(operation.id, operation.claim_id, number,
    pg_temp.merge_url(operation.epoch_id, number));
  if observation is null then raise exception 'Expected a fenced canonical synchronization observation.'; end if;
  return observation;
end;
$$;

create function pg_temp.finish_open_sync(target_operation uuid, number integer, provider_updated_at timestamptz)
returns boolean language sql as $$
  select public.finish_session_pr_sync(operation.id, operation.claim_id, operation.desired_sha, operation.desired_fence_sha,
    number, pg_temp.merge_url(operation.epoch_id, number), 'open', true, operation.desired_sha, provider_updated_at,
    pg_temp.reserve_merge_sync(operation, number))
  from public.session_pr_operations operation where operation.id = target_operation
$$;

create function pg_temp.reserve_merge_observation(target_epoch uuid, number integer)
returns uuid language sql as $$
  select public.begin_session_pr_observation(workspace_id, repository_id, branch_name, number)
  from public.session_pr_epochs where id = target_epoch
$$;

create function pg_temp.finish_merge_observation(
  observation uuid, target_epoch uuid, number integer, pr_state text, source_head text,
  provider_updated_at timestamptz, merge_time timestamptz default null, merge_commit text default null
) returns boolean language sql as $$
  select public.finish_session_pr_observation_with_merge(
    p_observation_id => observation, p_pr_url => pg_temp.merge_url(target_epoch, number),
    p_pr_state => pr_state, p_is_draft => false, p_pr_head_sha => source_head, p_pr_updated_at => provider_updated_at,
    p_merged_at => merge_time, p_merge_commit_sha => merge_commit,
    p_merge_source_head_sha => case when merge_time is not null or merge_commit is not null then source_head end
  )
$$;

create function pg_temp.finish_terminal_merge_sync(
  target_operation uuid, captured_claim uuid, target_epoch uuid, observation uuid, merge_commit text
) returns boolean language sql as $$
  select public.finish_session_pr_sync_with_merge(
    p_operation_id => target_operation, p_claim_id => captured_claim,
    p_observed_head_sha => null, p_observed_fence_sha => null, p_pr_number => 59103,
    p_pr_url => pg_temp.merge_url(target_epoch, 59103),
    p_pr_state => 'merged', p_is_draft => false, p_pr_head_sha => repeat('b', 40), p_pr_updated_at => '2026-11-10T12:00:00Z',
    p_observation_id => observation, p_merged_at => '2026-11-10T09:00:00Z',
    p_merge_commit_sha => merge_commit, p_merge_source_head_sha => repeat('b', 40)
  )
$$;

create temp table observed_session as select pg_temp.merge_fixture('Observed canonical merge') session_id;
create temp table first_publication as select operation.*
from pg_temp.merge_claim((select session_id from observed_session)) operation;
select ok((select pg_temp.finish_open_sync(id, 59101, '2026-11-09T10:00:00Z') from first_publication),
  'the first accepted checkpoint publishes and synchronizes an open canonical PR');
select is((select count(*) from internal.factory_canonical_pull_request_merges
  where session_id = (select session_id from observed_session)), 0::bigint,
  'publication, checkpoint adoption, and an open canonical PR never count as delivery');

create temp table exact_source as
select pg_temp.merge_revision((select session_id from observed_session), repeat('c', 40)) run_id;
create temp table exact_publication as select operation.*
from pg_temp.merge_claim((select session_id from observed_session)) operation;
select ok((select operation.checkpoint_run_id = source.run_id
  and pg_temp.finish_open_sync(operation.id, 59101, '2026-11-09T11:00:00Z')
  from exact_publication operation cross join exact_source source),
  'a second exact checkpoint synchronizes to the same canonical PR');
create temp table unpublished_source as
select pg_temp.merge_revision((select session_id from observed_session), repeat('d', 40)) run_id;
select ok((select epoch.pr_state = 'open' and epoch.pr_head_sha = repeat('c', 40)
    and sync.desired_checkpoint_run_id = source.run_id
  from public.session_pr_sync sync join public.session_pr_epochs epoch on epoch.id = sync.current_epoch_id
  cross join unpublished_source source
  where epoch.id = (select epoch_id from exact_publication)),
  'an accepted but unpublished checkpoint does not move the observed PR head');

create temp table stale_observation as
select pg_temp.reserve_merge_observation(epoch_id, 59101) id from exact_publication;
create temp table current_observation as
select pg_temp.reserve_merge_observation(epoch_id, 59101) id from exact_publication;
select ok((select id is not null from current_observation), 'a scoped observer reserves an exact canonical PR read');
select is((select pg_temp.finish_merge_observation(stale.id, operation.epoch_id, 59101, 'merged', repeat('b', 40),
  '2026-11-10T12:00:00Z', '2026-11-10T09:00:00Z', repeat('e', 40))
  from stale_observation stale cross join exact_publication operation), false,
  'the superseded read token cannot publish even plausible complete merge facts');
select is((select count(*) from internal.factory_canonical_pull_request_merges
  where session_id = (select session_id from observed_session)), 0::bigint, 'a stale provider response writes no merge subject');
select ok((select pg_temp.finish_merge_observation(current.id, operation.epoch_id, 59101, 'merged', repeat('c', 40),
  '2026-11-10T12:00:00Z', '2026-11-10T09:00:00Z', repeat('f', 40))
  from current_observation current cross join exact_publication operation),
  'the original exact provider merge is accepted through the canonical observer');

create temp table initial_merge as select facts.* from internal.current_factory_canonical_pull_request_merges facts
where session_id = (select session_id from observed_session);
select ok((select facts.status = 'observed' and facts.workspace_id = epoch.workspace_id
    and facts.factory_id = session.factory_id and facts.repository_id = epoch.repository_id
    and facts.source_host = 'github.com' and facts.github_repository_id = epoch.github_repository_id
    and facts.pull_request_number = 59101
    and facts.merged_at = '2026-11-10T09:00:00Z'::timestamptz and facts.observed_at > facts.merged_at
    and facts.provider_updated_at = '2026-11-10T12:00:00Z'::timestamptz
    and facts.merge_commit_sha = repeat('f', 40) and facts.merge_source_head_sha = repeat('c', 40)
  from initial_merge facts join public.session_pr_epochs epoch on epoch.id = facts.epoch_id
  join public.sessions session on session.id = facts.session_id),
  'a late observation preserves exact tenant, provider identity, provider timestamp, receipt timestamp, and distinct commit hashes');
select results_eq($q$
  select source.run_id, source.attempt_count, source.operation_id
  from internal.factory_canonical_pull_request_merge_runs source
  where source.observation_id = (select observation_id from initial_merge)
$q$, $q$
  select operation.checkpoint_run_id, checkpoint.attempt_count, operation.id
  from exact_publication operation join public.session_git_checkpoints checkpoint on checkpoint.run_id = operation.checkpoint_run_id
$q$, 'only the matching exact synchronization receipt contributes a run, excluding old and unpublished heads');

select ok((select pg_temp.finish_merge_observation(pg_temp.reserve_merge_observation(epoch_id, 59101), epoch_id, 59101,
  'merged', repeat('c', 40), '2026-11-10T12:00:00Z', '2026-11-10T09:00:00Z', repeat('f', 40))
  from exact_publication), 'an identical authenticated provider refresh still settles normally');
select is((select count(*) from internal.factory_canonical_pull_request_merge_observations
  where merge_id = (select id from initial_merge)), 1::bigint,
  'identical authenticated refreshes do not duplicate immutable snapshots');
select is((select count(*) from internal.factory_canonical_pull_request_merge_receipts
  where observation_id = (select observation_id from initial_merge) and source = 'webhook'), 2::bigint,
  'the same snapshot retains each successfully fenced read without double counting the event');

select ok((select pg_temp.finish_merge_observation(pg_temp.reserve_merge_observation(epoch_id, 59101), epoch_id, 59101,
  'merged', repeat('b', 40), '2026-11-10T12:00:00Z', '2026-11-10T09:15:00Z', repeat('e', 40))
  from exact_publication), 'equally dated conflicting provider evidence is retained as a separate observation');
select results_eq($q$
  select id, status from internal.current_factory_canonical_pull_request_merges
  where session_id = (select session_id from observed_session)
$q$, $q$select id, 'conflicting'::text from initial_merge$q$,
  'conflicting maximum provider versions leave one canonical identity with no observed delivery');

select ok((select pg_temp.finish_merge_observation(pg_temp.reserve_merge_observation(epoch_id, 59101), epoch_id, 59101,
  'merged', repeat('b', 40), '2026-11-11T12:00:00Z', '2026-11-10T09:15:00Z', repeat('e', 40))
  from exact_publication), 'a newer exact provider observation resolves the conflict');
create temp table corrected_merge as select * from internal.current_factory_canonical_pull_request_merges
where session_id = (select session_id from observed_session);
select ok((select corrected.id = initial.id and corrected.observation_id <> initial.observation_id
    and corrected.status = 'observed' and corrected.merged_at = '2026-11-10T09:15:00Z'::timestamptz
    and corrected.merge_commit_sha = repeat('e', 40)
  from corrected_merge corrected cross join initial_merge initial),
  'provider correction changes the selected fact without adding another canonical merge');
select results_eq($q$
  select source.run_id, source.operation_id from internal.factory_canonical_pull_request_merge_runs source
  where source.observation_id = (select observation_id from corrected_merge)
$q$, $q$select checkpoint_run_id, id from first_publication$q$,
  'the revised source links to its own exact earlier synchronization receipt');
select is((select count(*) from internal.factory_canonical_pull_request_merge_observations
  where merge_id = (select id from initial_merge)), 3::bigint,
  'original, conflicting, and corrected facts remain queryable without changing their source history');
select is((select pg_temp.finish_merge_observation(pg_temp.reserve_merge_observation(epoch_id, 59101), epoch_id, 59101,
  'merged', repeat('c', 40), '2026-11-10T13:00:00Z', '2026-11-10T09:00:00Z', repeat('f', 40))
  from exact_publication), false, 'a delayed older provider version cannot overwrite the current correction');

create temp table closed_session as select pg_temp.merge_fixture('Closed without merge') session_id;
create temp table closed_publication as select operation.*
from pg_temp.merge_claim((select session_id from closed_session)) operation;
select ok((select pg_temp.finish_open_sync(id, 59102, '2026-11-09T10:00:00Z') from closed_publication),
  'closed fixture first establishes a trusted canonical PR identity');
create temp table closed_observation as select pg_temp.reserve_merge_observation(epoch_id, 59102) id
from closed_publication;
select throws_ok($q$
  select pg_temp.finish_merge_observation(observation.id, operation.epoch_id, 59102, 'merged', repeat('b', 40),
    '2026-11-10T12:00:00Z', '2026-11-10T09:00:00Z')
  from closed_observation observation cross join closed_publication operation
$q$, '22023', null, 'a merged state lacks authority without the exact provider merge commit');
select throws_ok($q$
  select pg_temp.finish_merge_observation(observation.id, operation.epoch_id, 59102, 'closed', repeat('b', 40),
    '2026-11-10T12:00:00Z', '2026-11-10T09:00:00Z', repeat('f', 40))
  from closed_observation observation cross join closed_publication operation
$q$, '22023', null, 'closed state cannot accept contradictory merge proof');
select ok((select public.finish_session_pr_observation(observation.id, pg_temp.merge_url(operation.epoch_id, 59102),
  'closed', false, repeat('b', 40), '2026-11-10T12:00:00Z')
  from closed_observation observation cross join closed_publication operation),
  'closed-unmerged observations still update canonical product state');
select is((select count(*) from internal.factory_canonical_pull_request_merges
  where session_id = (select session_id from closed_session)), 0::bigint, 'closed-unmerged PRs contribute no delivery');

create temp table publisher_session as select pg_temp.merge_fixture('Publisher terminal merge') session_id;
create temp table publisher_synced as select operation.*
from pg_temp.merge_claim((select session_id from publisher_session)) operation;
select ok((select pg_temp.finish_open_sync(id, 59103, '2026-11-09T10:00:00Z') from publisher_synced),
  'publisher fixture has an exact open receipt before its next revision');
select pg_temp.merge_revision((select session_id from publisher_session), repeat('c', 40));
create temp table publisher_terminal as select operation.*
from pg_temp.merge_claim((select session_id from publisher_session)) operation;
create temp table publisher_merge_snapshot as
select pg_temp.reserve_merge_sync(operation, 59103) id
from public.session_pr_operations operation where id = (select id from publisher_terminal);
select ok((select pg_temp.finish_terminal_merge_sync(operation.id, operation.claim_id, operation.epoch_id,
    observation.id, repeat('d', 40)) from publisher_terminal operation cross join publisher_merge_snapshot observation),
  'the fenced terminal publisher path also durably records exact provider merge evidence');
select ok((select pg_temp.finish_terminal_merge_sync(operation.id, operation.claim_id, operation.epoch_id,
    observation.id, repeat('d', 40)) from publisher_terminal operation cross join publisher_merge_snapshot observation),
  'the same accepted publisher response can be replayed after response loss');
select is((select pg_temp.finish_terminal_merge_sync(operation.id, operation.claim_id, operation.epoch_id,
    observation.id, repeat('e', 40)) from publisher_terminal operation cross join publisher_merge_snapshot observation),
  false, 'a replayed publisher fence cannot substitute a different merge commit');
select is((select count(*) from internal.factory_canonical_pull_request_merge_receipts
  where id = (select id from publisher_merge_snapshot) and source = 'sync'),
  1::bigint, 'the accepted publisher fence remains one durable sync receipt');
select results_eq($q$
  select source.run_id, source.operation_id
  from internal.current_factory_canonical_pull_request_merges current
  join internal.factory_canonical_pull_request_merge_runs source on source.observation_id = current.observation_id
  where current.session_id = (select session_id from publisher_session)
$q$, $q$select checkpoint_run_id, id from publisher_synced$q$,
  'publisher merge associates its prior proven open synchronization, never its unsynchronized latest attempt');

select ok(not has_table_privilege('authenticated', 'internal.current_factory_canonical_pull_request_merges', 'select')
    and not has_table_privilege('service_role', 'internal.factory_canonical_pull_request_merge_observations', 'select,insert,update,delete')
    and not has_function_privilege('authenticated',
      'public.finish_session_pr_observation_with_merge(uuid,text,text,boolean,text,timestamptz,timestamptz,text,text)', 'execute'),
  'raw merge evidence and privileged ingestion stay outside browser and general service-role table access');

delete from public.sessions where id = (select session_id from publisher_session);
select ok(not exists (select 1 from internal.factory_canonical_pull_request_merges
    where session_id = (select session_id from publisher_session))
  and not exists (select 1 from internal.factory_canonical_pull_request_merge_receipts
    where id = (select id from publisher_merge_snapshot))
  and exists (select 1 from internal.factory_canonical_pull_request_merges
    where session_id = (select session_id from observed_session)),
  'owner deletion cascades through merge evidence without removing a sibling session’s facts');

select * from finish();
rollback;
