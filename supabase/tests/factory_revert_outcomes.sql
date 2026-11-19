begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';

select public.set_git_continuity_release(true, revision, 'Factory revert outcomes fixture')
from public.get_git_continuity_release_state() where not enabled;

create function pg_temp.revert_id(slot integer) returns uuid language sql immutable as $$
  select ('59600000-0000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

create function pg_temp.revert_time(days_ago integer) returns timestamptz language sql stable as $$
  select transaction_timestamp() - make_interval(secs => days_ago * 86400)
$$;

update internal.factory_outcome_capture_coverage set live_from = pg_temp.revert_time(60)
where source = 'pull_requests';

insert into auth.users(id, email) values
  (pg_temp.revert_id(1), 'revert-manager@example.test'), (pg_temp.revert_id(2), 'revert-reader@example.test');
insert into public.workspaces(id, slug, name) values (pg_temp.revert_id(4), 'revert-fixture', 'Revert outcomes');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  (pg_temp.revert_id(11), pg_temp.revert_id(4), pg_temp.revert_id(1), 'human', 'owner'),
  (pg_temp.revert_id(12), pg_temp.revert_id(4), pg_temp.revert_id(2), 'human', 'member');

create function pg_temp.revert_factory() returns uuid language sql stable as $$
  select id from public.factories where workspace_id = pg_temp.revert_id(4) and is_default
$$;

select public.grant_factory_membership(pg_temp.revert_id(4), pg_temp.revert_factory(),
  pg_temp.revert_id(1), pg_temp.revert_id(12), 'member');
create temp table revert_sibling as select id from public.create_factory(
  pg_temp.revert_id(4), pg_temp.revert_id(1), 'Unshared revert metrics', 'revert-sibling');
grant select on revert_sibling to authenticated;

insert into public.pipelines(id, workspace_id, factory_id, name, is_default)
values (pg_temp.revert_id(20), pg_temp.revert_id(4), pg_temp.revert_factory(), 'Revert metrics fixture', true);
insert into public.pipeline_stages(id, pipeline_id, workspace_id, position, slug, name, prompt_template_md)
values (pg_temp.revert_id(21), pg_temp.revert_id(20), pg_temp.revert_id(4), 1, 'build', 'Build', 'Make the change.');
insert into public.github_installations(id, workspace_id, installation_id, installation_url, app_id, target_type, target_name, permissions)
values (pg_temp.revert_id(30), pg_temp.revert_id(4), 59600030, 'https://github.test/installations/59600030', 596000,
  'Organization', 'revert-fixture', '{"contents":"write","pull_requests":"write"}');
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name, full_name, private, html_url, default_branch)
values (pg_temp.revert_id(31), pg_temp.revert_id(4), pg_temp.revert_factory(), pg_temp.revert_id(30),
  59600031, 'delivery', 'fixture/delivery', true, 'https://github.test/fixture/delivery', 'main');

create temp table revert_originals(slot, label, base_branch, merged_at) as values
  (101, 'confirmed', 'main', pg_temp.revert_time(46)),
  (102, 'covered', 'main', pg_temp.revert_time(45)),
  (103, 'candidate', 'main', pg_temp.revert_time(44)),
  (104, 'corrected', 'main', pg_temp.revert_time(43)),
  (105, 'late', 'main', pg_temp.revert_time(42)),
  (106, 'immature', 'main', pg_temp.revert_time(5)),
  (107, 'other-base', 'release', pg_temp.revert_time(41));

insert into public.sessions(id, workspace_id, factory_id, number, title, creator_member_id, pipeline_id, current_stage_id, created_at)
select pg_temp.revert_id(slot), pg_temp.revert_id(4), pg_temp.revert_factory(), slot, label,
  pg_temp.revert_id(11), pg_temp.revert_id(20), pg_temp.revert_id(21), merged_at - interval '1 hour'
from revert_originals;

create function pg_temp.observe_revert_original(p_slot integer, p_base_branch text, p_merged_at timestamptz)
returns boolean language plpgsql as $$
declare
  session_id uuid := pg_temp.revert_id(p_slot);
  epoch_id uuid := pg_temp.revert_id(p_slot + 100);
  branch_name text := 'wallie/sessions/' || session_id::text || '/' || epoch_id::text;
  pr_url text := 'https://github.test/fixture/delivery/pull/' || p_slot::text;
begin
  insert into public.session_git_roots(session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha)
  values(session_id, pg_temp.revert_id(4), pg_temp.revert_id(31), 'fixture/delivery', p_base_branch, repeat('a', 40));
  insert into public.session_pr_epochs(id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
    github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha, created_at)
  values(epoch_id, session_id, pg_temp.revert_id(4), 1, pg_temp.revert_id(31), 'fixture/delivery',
    59600031, p_base_branch, branch_name, 'refs/wallie/fences/' || epoch_id::text, p_slot, pr_url,
    'open', false, repeat('e', 40), p_merged_at - interval '30 minutes');
  return public.finish_session_pr_observation_with_merge(
    public.begin_session_pr_observation(pg_temp.revert_id(4), pg_temp.revert_id(31), branch_name, p_slot),
    pr_url, 'merged', false, repeat('e', 40), p_merged_at, p_merged_at,
    lpad(to_hex(p_slot), 40, '0'), repeat('e', 40));
end;
$$;

select ok(bool_and(pg_temp.observe_revert_original(slot, base_branch, merged_at)),
  'cohort originals come from accepted fenced canonical GitHub observations') from revert_originals;
create temp table revert_targets as
select original.slot, original.label, merge.id, merge.observation_id, merge.merged_at, merge.merge_commit_sha
from revert_originals original join internal.current_factory_canonical_pull_request_merges merge
  on merge.session_id = pg_temp.revert_id(original.slot) and merge.status = 'observed';
grant select on revert_targets to authenticated;

create function pg_temp.revert_merge_id(p_label text) returns uuid language sql stable as $$
  select id from revert_targets where label = p_label
$$;

create function pg_temp.revert_proof(p_pr integer, p_days_ago integer, p_repository bigint default 59600031,
  p_base_branch text default 'main') returns jsonb language sql stable as $$
  select jsonb_build_object('repositoryNumericId', p_repository, 'baseBranch', p_base_branch,
    'pullRequestNumber', p_pr, 'mergeCommitSha', lpad(to_hex(p_pr), 40, '0'),
    'mergedAt', pg_temp.revert_time(p_days_ago), 'updatedAt', pg_temp.revert_time(p_days_ago) + interval '1 second')
$$;

create function pg_temp.save_revert(p_label text, p_pr integer, p_expected integer, p_request integer, p_status text,
  p_proof jsonb default null, p_actor integer default 1) returns jsonb language sql as $$
  select public.save_factory_revert_relationship(pg_temp.revert_id(4), pg_temp.revert_factory(), pg_temp.revert_id(p_actor),
    target.id, p_pr, p_expected, pg_temp.revert_id(p_request), p_status, target.observation_id, p_proof)
  from revert_targets target where target.label = p_label
$$;

select ok(not has_function_privilege('authenticated', 'public.save_factory_revert_relationship(uuid,uuid,uuid,uuid,integer,integer,uuid,text,uuid,jsonb)', 'execute')
  and not has_table_privilege('authenticated', 'internal.factory_revert_relationship_revisions', 'select,insert,update,delete'),
  'client roles cannot supply provider proof or access the private revision records');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 0, 300, 'candidate', p_actor => 2)$$,
  '42501', null, 'a factory member cannot assert a revert through the service on their behalf');
select throws_ok($$select public.get_factory_revert_target(pg_temp.revert_id(4), id, pg_temp.revert_id(1),
  pg_temp.revert_merge_id('confirmed')) from revert_sibling$$,
  'PT404', null, 'a manager cannot reuse canonical original evidence in a different factory');
select ok((select (proof.result->>'observationId')::uuid = target.observation_id
  and (proof.result->>'repositoryNumericId')::bigint = 59600031
  and (proof.result->>'installationId')::bigint = 59600030 and proof.result->>'baseBranch' = 'main'
  from revert_targets target cross join lateral (
    select public.get_factory_revert_target(pg_temp.revert_id(4), pg_temp.revert_factory(),
      pg_temp.revert_id(1), target.id) result
  ) proof where target.label = 'confirmed'),
  'authorized verification receives the current original observation and the installed source repository identity');

create temp table revert_candidate as
select pg_temp.save_revert('confirmed', 901, 0, 301, 'candidate') as result;
select is((select result->>'status' from revert_candidate), 'candidate',
  'a manager can record a candidate without presenting it as a verified revert');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 1, 302, 'confirmed', pg_temp.revert_proof(901, 36, 9999999))$$,
  '22023', null, 'a different provider repository cannot establish the revert');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 1, 302, 'confirmed',
  pg_temp.revert_proof(901, 36, p_base_branch => 'release'))$$,
  '22023', null, 'a revert must merge to the same branch as the original change');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 1, 302, 'confirmed', pg_temp.revert_proof(901, 47))$$,
  '22023', null, 'revert source time must follow the original merge');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 1, 302, 'confirmed', pg_temp.revert_proof(901, -1))$$,
  '22023', null, 'future provider evidence cannot establish a confirmed revert');

create temp table revert_confirmed as
select pg_temp.save_revert('confirmed', 901, 1, 302, 'confirmed', pg_temp.revert_proof(901, 16)) as result;
select ok((select (saved.result->>'revision')::integer = 2 and saved.result->>'status' = 'confirmed'
  and (saved.result->>'originalObservationId')::uuid = target.observation_id
  and saved.result->>'originalMergeSha' = target.merge_commit_sha
  and (saved.result->>'revertMergedAt')::timestamptz = pg_temp.revert_time(16)
  and (saved.result->>'observedAt')::timestamptz > (saved.result->>'revertMergedAt')::timestamptz
  and (saved.result->>'actorMemberId')::uuid = pg_temp.revert_id(11)
  from revert_confirmed saved cross join revert_targets target where target.label = 'confirmed'),
  'confirmation retains both exact GitHub identities, source time, receipt time and manager provenance');
select is(pg_temp.save_revert('confirmed', 901, 0, 301, 'candidate'), (select result from revert_candidate),
  'retrying the prior command returns its exact receipt after the relationship advanced');
select throws_ok($$select pg_temp.save_revert('confirmed', 902, 0, 301, 'candidate')$$,
  'PT409', null, 'a reused command ID with different intent is rejected');
select throws_ok($$select pg_temp.save_revert('confirmed', 901, 1, 303, 'invalidated')$$,
  'PT409', null, 'a stale observed revision cannot invalidate newer evidence');

select pg_temp.save_revert('candidate', 903, 0, 304, 'candidate');
select pg_temp.save_revert('corrected', 904, 0, 305, 'confirmed', pg_temp.revert_proof(904, 33));
select ok((select (result->>'revision')::integer = 2 and result->>'status' = 'invalidated'
    and result->>'revertMergeSha' = pg_temp.revert_proof(904, 33)->>'mergeCommitSha'
  from (select pg_temp.save_revert('corrected', 904, 1, 306, 'invalidated') result) saved),
  'a correction invalidates current evidence and retains the prior provider provenance');
select pg_temp.save_revert('late', 905, 0, 307, 'confirmed', pg_temp.revert_proof(905, 11));

create function pg_temp.revert_summary() returns jsonb language sql as $$
  select public.get_factory_revert_summary(pg_temp.revert_id(4), pg_temp.revert_factory(),
    pg_temp.revert_time(50), pg_temp.revert_time(1))
$$;
create function pg_temp.revert_evidence(p_status text default null, p_limit integer default 25) returns jsonb language sql as $$
  select public.list_factory_revert_evidence(pg_temp.revert_id(4), pg_temp.revert_factory(),
    pg_temp.revert_time(50), pg_temp.revert_time(1), p_status, p_limit)
$$;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59600000-0000-4000-8000-000000000002';
select throws_ok($$select public.get_factory_revert_summary(pg_temp.revert_id(4), id,
  pg_temp.revert_time(50), pg_temp.revert_time(1)) from revert_sibling$$,
  'PT404', null, 'a factory viewer cannot read counts from an unshared sibling factory');
select throws_ok($$select public.list_factory_revert_evidence(pg_temp.revert_id(4), id,
  pg_temp.revert_time(50), pg_temp.revert_time(1)) from revert_sibling$$,
  'PT404', null, 'the evidence drilldown uses the same factory access boundary');
select ok((select (result->>'observedMergeCount')::integer = 7 and (result->>'coveredMatureCount')::integer = 0
  and (result->>'verifiedRevertedCount')::integer = 1 and result->'revertRate' = 'null'::jsonb
  from (select pg_temp.revert_summary() result) summary),
  'without attested coverage there is a verified positive but no measurable revert rate');

reset role;
set local request.jwt.claim.role = 'service_role';
create function pg_temp.record_revert_coverage(p_start integer, p_end integer, p_request integer,
  p_base text default 'main') returns jsonb language sql as $$
  select public.record_factory_revert_coverage(pg_temp.revert_id(4), pg_temp.revert_factory(), pg_temp.revert_id(1),
    pg_temp.revert_id(31), p_base, pg_temp.revert_time(p_start), pg_temp.revert_time(p_end), pg_temp.revert_id(p_request))
$$;
create temp table revert_first_coverage as select pg_temp.record_revert_coverage(50, 29, 399) result;
create temp table revert_coverage_receipt as select pg_temp.record_revert_coverage(29, 10, 400) result;
select ok((select result->>'baseBranch' = 'main' and (result->>'from')::timestamptz = pg_temp.revert_time(50)
  and (result->>'through')::timestamptz = pg_temp.revert_time(29)
  and (result->>'actorMemberId')::uuid = pg_temp.revert_id(11) from revert_first_coverage),
  'coverage confirms an exact repository/base interval and records the attesting manager');
select is(pg_temp.record_revert_coverage(29, 10, 400), (select result from revert_coverage_receipt),
  'an identical coverage request does not duplicate the attestation');
select throws_ok($$select pg_temp.record_revert_coverage(29, -1, 401)$$,
  '22023', null, 'future time cannot be included in a manager coverage attestation');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '59600000-0000-4000-8000-000000000002';
select ok((select result->>'metricKey' = 'canonical_revert_rate'
  and (result #>> '{window,observationWindowSeconds}')::integer = 2592000
  and (result->>'coveredMatureCount')::integer = 4 and (result->>'revertedCoveredCount')::integer = 1
  and (result->>'immatureCount')::integer = 1 and (result->>'partialCount')::integer = 1
  and (result->>'ambiguousCount')::integer = 1 and (result->>'revertRate')::numeric = 0.25
  from (select pg_temp.revert_summary() result) summary),
  'adjacent attestations cover mature unambiguous originals and the rate includes the exact 30-day boundary');
select results_eq(
  $$select (item->>'pullRequestNumber')::integer, item->>'status', (item->>'hasVerifiedRevert')::boolean
    from jsonb_array_elements(pg_temp.revert_evidence()->'items') item order by (item->>'pullRequestNumber')::integer$$,
  $$values (101, 'covered'::text, true), (102, 'covered'::text, false), (103, 'ambiguous'::text, false),
    (104, 'covered'::text, false), (105, 'covered'::text, false), (106, 'immature'::text, false), (107, 'partial'::text, false)$$,
  'evidence distinguishes mature coverage, unresolved candidates, late reverts, immature windows and another base branch');
select ok((select jsonb_array_length(result->'items') = 1
  and (result #>> '{items,0,originalMergeId}')::uuid = pg_temp.revert_merge_id('candidate')
  and result->'nextCursor' = 'null'::jsonb from (select pg_temp.revert_evidence('ambiguous', 1) result) page),
  'status-specific evidence paging shows the actual unresolved original');

select ok((select jsonb_array_length(result->'items') = (pg_temp.revert_summary()->>'revertedCoveredCount')::integer
  and result #>> '{items,0,hasVerifiedRevert}' = 'true' and result #>> '{items,0,status}' = 'covered'
  and result #>> '{items,0,originalMergeId}' = pg_temp.revert_merge_id('confirmed')::text
  and result->'nextCursor' = 'null'::jsonb
  from (select public.list_factory_revert_evidence(pg_temp.revert_id(4), pg_temp.revert_factory(),
    pg_temp.revert_time(50), pg_temp.revert_time(1), p_status => 'covered',
    p_limit => 1, p_has_verified_revert => true) result) page),
  'revert numerator evidence selects verified originals inside the same mature-covered cohort before paging');

reset role;
set local request.jwt.claim.role = 'service_role';
select public.withdraw_factory_revert_coverage(pg_temp.revert_id(4), pg_temp.revert_factory(), pg_temp.revert_id(1),
  (result->>'id')::uuid) from revert_coverage_receipt;
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select (result->>'coveredMatureCount')::integer = 0
  and (result->>'verifiedRevertedCount')::integer = 1 and result->'revertRate' = 'null'::jsonb
  from (select pg_temp.revert_summary() result) summary),
  'withdrawing the final coverage segment removes the denominator without deleting verified evidence');

reset role;
set local request.jwt.claim.role = 'service_role';
select ok((select public.finish_session_pr_observation_with_merge(
  public.begin_session_pr_observation(epoch.workspace_id, epoch.repository_id, epoch.branch_name, epoch.pr_number),
  epoch.pr_url, 'merged', false, repeat('e', 40), target.merged_at + interval '1 minute', target.merged_at,
  repeat('c', 40), repeat('e', 40))
  from public.session_pr_epochs epoch join revert_targets target on target.slot = epoch.pr_number
  where target.label = 'confirmed' and epoch.workspace_id = pg_temp.revert_id(4)),
  'a strictly newer GitHub observation can correct the original merge identity');
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
select ok((select (item->>'originalObservationId')::uuid <> target.observation_id
  and item->>'originalMergeSha' = repeat('c', 40) and not (item->>'hasVerifiedRevert')::boolean
  and item->>'status' = 'ambiguous' and item #>> '{relationships,0,evidenceState}' = 'stale'
  from jsonb_array_elements(pg_temp.revert_evidence()->'items') item
  join revert_targets target on target.id = (item->>'originalMergeId')::uuid where target.label = 'confirmed'),
  'a confirmation for the prior canonical snapshot cannot verify a corrected original commit');

reset role;
select * from finish();
rollback;
