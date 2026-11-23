begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set op651_fixture_namespace 66210000
\ir fixtures/factory_automation_dry_run.psql

create temp table github_automation_rule as
select scope.*, (draft.value->>'automationId')::uuid as automation_id, (draft.value->>'draftRevisionId')::uuid as revision_id
from op651_scope scope
cross join lateral (select pg_temp.create_dry_run_automation(101, pg_temp.dry_run_definition('pull-request')) as value) draft;
select public.publish_factory_automation(workspace_id, factory_id, pg_temp.op651_id(1), automation_id, revision_id)
from github_automation_rule;

create function pg_temp.deliver_github_pr(
  p_delivery_slot integer, p_action text, p_state text, p_time timestamptz,
  p_head_sha text default repeat('a', 40), p_pr_number integer default 42,
  p_head_branch text default 'contributor/change', p_head_repository_id bigint default 0,
  p_repository_offset integer default 34, p_installation_offset integer default 33,
  p_pr_id_offset integer default 0
) returns jsonb language sql as $$
  select public.ingest_factory_github_automation_pr(
    current_setting('wallie.op651_fixture_namespace')::bigint + p_installation_offset,
    current_setting('wallie.op651_fixture_namespace')::bigint + p_repository_offset,
    pg_temp.op651_id(p_delivery_slot),
    5000::bigint + p_pr_number + p_pr_id_offset, p_pr_number, p_action, p_state, false,
    p_time, 'main', p_head_branch, p_head_sha,
    case when p_head_repository_id = 0 then current_setting('wallie.op651_fixture_namespace')::bigint + p_repository_offset
      else p_head_repository_id end,
    case when p_action = 'merged' then repeat('f', 40) end
  )
$$;

select ok(has_function_privilege('service_role',
  'public.ingest_factory_github_automation_pr(bigint,bigint,uuid,bigint,integer,text,text,boolean,timestamptz,text,text,text,bigint,text)', 'execute')
  and not has_function_privilege('authenticated',
  'public.ingest_factory_github_automation_pr(bigint,bigint,uuid,bigint,integer,text,text,boolean,timestamptz,text,text,text,bigint,text)', 'execute'),
  'only trusted webhook ingress can submit verified PR identities');

select is(pg_temp.deliver_github_pr(110, 'opened', 'open', '2026-11-23T08:01Z', p_installation_offset=>97),
  null::jsonb, 'an unmapped installation and repository produce no scoped receipt');
select is(pg_temp.deliver_github_pr(110, 'opened', 'open', '2026-11-23T08:01Z', p_repository_offset=>97),
  null::jsonb, 'an existing installation cannot attribute an unknown repository');
select is((select count(*) from internal.github_automation_pr_deliveries where workspace_id = pg_temp.op651_id(11)), 0::bigint,
  'unscoped provider identities leave no automation traffic');

create temp table first_delivery as
select pg_temp.deliver_github_pr(110, 'opened', 'open', '2026-11-23T08:01Z') as receipt;
select ok(receipt->>'status' = 'accepted' and receipt->>'occurrenceCount' = '0',
  'a valid PR event has an independent receipt even without a matching rule') from first_delivery;
select is(pg_temp.deliver_github_pr(110, 'opened', 'open', '2026-11-23T08:01Z'),
  receipt || '{"replayed":true}', 'exact delivery replay returns the original receipt') from first_delivery;
select throws_ok($$
  select pg_temp.deliver_github_pr(110, 'synchronize', 'open', '2026-11-23T08:02Z')
$$, 'PT409', 'The GitHub delivery already identifies different input.',
  'a delivery ID cannot be reused to change its signed event details');
select is((select count(*) from internal.github_pr_refresh_deliveries where delivery_id = pg_temp.op651_id(110)::text), 0::bigint,
  'automation intake does not consume the PR verification dedupe record');
select public.enqueue_github_pr_refresh_event(
  current_setting('wallie.op651_fixture_namespace')::bigint + 33,
  current_setting('wallie.op651_fixture_namespace')::bigint + 34, pg_temp.op651_id(110)::text,
  p_pr_numbers=>array[42]);
select is((select count(*) from internal.github_pr_refresh_deliveries where delivery_id = pg_temp.op651_id(110)::text),
  1::bigint, 'independent verification still accepts the same provider delivery even with no matching rule');

select is(pg_temp.deliver_github_pr(111, 'synchronize', 'open', '2026-11-23T08:03Z', repeat('b',40))->>'status',
  'accepted', 'a newer open source snapshot advances its PR watermark');
select is(pg_temp.deliver_github_pr(112, 'ready_for_review', 'open', '2026-11-23T08:02Z')->>'status',
  'stale', 'a late older event cannot advance the PR watermark');
select is(pg_temp.deliver_github_pr(113, 'synchronize', 'open', '2026-11-23T08:03Z', repeat('c',40))->>'status',
  'ambiguous', 'same-second contradictory heads are retained without guessing their order');
select is(pg_temp.deliver_github_pr(114, 'closed', 'closed', '2026-11-23T08:04Z', repeat('b',40))->>'status',
  'accepted', 'closing without a merge does not make the provider PR terminal');
select is(pg_temp.deliver_github_pr(115, 'reopened', 'open', '2026-11-23T08:05Z', repeat('b',40))->>'status',
  'accepted', 'a later verified reopen is accepted for an unmerged PR');
select is(pg_temp.deliver_github_pr(116, 'synchronize', 'open', '2026-11-23T08:06Z',
  p_pr_id_offset=>99)->>'status', 'ambiguous', 'same repository and number cannot silently move to a different PR identity');

create temp table merged_delivery as
select pg_temp.deliver_github_pr(117, 'merged', 'merged', '2026-11-23T08:07Z', repeat('b',40)) as receipt;
select ok(receipt->>'status' = 'accepted' and receipt->>'occurrenceCount' = '1',
  'a verified merge fans out once to the matching current rule') from merged_delivery;
select is(pg_temp.deliver_github_pr(118, 'merged', 'merged', '2026-11-23T08:07Z', repeat('b',40))->>'status',
  'duplicate', 'a second delivery GUID cannot replay one semantic source event');
select is(pg_temp.deliver_github_pr(119, 'synchronize', 'open', '2026-11-23T08:08Z', repeat('d',40))->>'status',
  'stale', 'a merged PR never reopens from a signed late delivery');
select is((select count(*) from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11)), 1::bigint,
  'duplicate, no-match, stale and terminal deliveries leave just one logical occurrence');

create temp table admitted_github_pr as select public.admit_next_factory_automation_occurrence() as receipt;
select is(receipt->>'status', 'admitted', 'the existing occurrence worker admits the normalized source') from admitted_github_pr;
select ok((select prompt_md like '%fixture/workflow-fixture#42%' and prompt_md like '%' || repeat('b',40) || '%'
  from public.sessions session join admitted_github_pr admitted on session.id = (admitted.receipt->>'sessionId')::uuid),
  'the admitted session retains the exact trusted repository, PR number and source head');

insert into public.session_pull_requests(
  session_id, workspace_id, github_repository_id, branch_name, pull_request_number, pull_request_url, pull_request_state, is_draft
)
select session.id, session.workspace_id, session.github_repository_id, 'wallie/legacy-automated-run', 43,
  'https://github.com/fixture/workflow-fixture/pull/43', 'open', false
from public.sessions session join admitted_github_pr admitted on session.id = (admitted.receipt->>'sessionId')::uuid;
select is(pg_temp.deliver_github_pr(120, 'merged', 'merged', '2026-11-23T08:09Z',
  p_pr_number=>43, p_head_branch=>'wallie/legacy-automated-run')->>'status',
  'causal_suppressed', 'the linked exact same-repo automated session cannot recursively trigger another job');
select is((select causal_session_id from internal.github_automation_pr_deliveries where delivery_id = pg_temp.op651_id(120)),
  (select (receipt->>'sessionId')::uuid from admitted_github_pr), 'the PR receipt retains the verified causal session');
insert into public.session_git_roots(
  session_id, workspace_id, repository_id, repository_full_name, base_branch, initial_base_sha
)
select session.id, session.workspace_id, repository.id, repository.full_name, 'main', repeat('a',40)
from public.sessions session join admitted_github_pr admitted on session.id = (admitted.receipt->>'sessionId')::uuid
join public.github_repositories repository on repository.id = session.github_repository_id;
insert into public.session_pr_epochs(
  id, session_id, workspace_id, epoch_number, repository_id, repository_full_name,
  github_repository_id, base_branch, branch_name, fence_branch, pr_number, pr_url, pr_state, is_draft, pr_head_sha
)
select pg_temp.op651_id(141), session.id, session.workspace_id, 1, repository.id, repository.full_name,
  repository.repo_id, 'main', 'wallie/sessions/' || session.id || '/' || pg_temp.op651_id(141),
  'refs/wallie/fences/' || pg_temp.op651_id(141), 46,
  'https://github.com/fixture/workflow-fixture/pull/46', 'open', false, repeat('a',40)
from public.sessions session join admitted_github_pr admitted on session.id = (admitted.receipt->>'sessionId')::uuid
join public.github_repositories repository on repository.id = session.github_repository_id;
select is(pg_temp.deliver_github_pr(123, 'merged', 'merged', '2026-11-23T08:09Z',
  p_pr_number=>46, p_head_branch=>epoch.branch_name, p_head_repository_id=>null)->>'status',
  'causal_suppressed', 'a deleted head repository cannot erase exact canonical session provenance')
from public.session_pr_epochs epoch where epoch.id = pg_temp.op651_id(141);
select is((select causal_session_id from internal.github_automation_pr_deliveries where delivery_id = pg_temp.op651_id(123)),
  (select (receipt->>'sessionId')::uuid from admitted_github_pr),
  'canonical PR ownership identifies the cause even when the signed event omits the head repository');

select is(pg_temp.deliver_github_pr(121, 'merged', 'merged', '2026-11-23T08:09Z',
  p_pr_number=>44, p_head_branch=>'wallie/improvements/reserved')->>'status',
  'causal_suppressed', 'unattributed same-repository publishing branches fail closed while links may be pending');
select is(pg_temp.deliver_github_pr(122, 'merged', 'merged', '2026-11-23T08:09Z',
  p_pr_number=>45, p_head_branch=>'wallie/improvements/reserved', p_head_repository_id=>80662)->>'status',
  'accepted', 'a fork branch name cannot impersonate an internal publication');
select is((select count(*) from internal.factory_automation_occurrences where workspace_id = pg_temp.op651_id(11)), 2::bigint,
  'only the two matching external merges can fan out to automation');

select is(pg_temp.deliver_github_pr(124, 'opened', 'open', '2026-11-23T08:10Z', p_pr_number=>47)->>'status',
  'accepted', 'the PR watermark records the open snapshot before a same-second merge');
select is(pg_temp.deliver_github_pr(125, 'merged', 'merged', '2026-11-23T08:10Z', p_pr_number=>47)->>'status',
  'accepted', 'verified merge evidence can establish terminal state in the same provider second');
select is(pg_temp.deliver_github_pr(126, 'synchronize', 'open', '2026-11-23T08:11Z', p_pr_number=>47)->>'status',
  'stale', 'the terminal receipt wins the cursor tie before any later open update');

select throws_ok($$
  delete from internal.github_automation_pr_deliveries where delivery_id = pg_temp.op651_id(110)
$$, '23514', 'Factory definition records are immutable.', 'the PR receipt stays durable for repeated delivery and ordering');
select * from finish();
rollback;
