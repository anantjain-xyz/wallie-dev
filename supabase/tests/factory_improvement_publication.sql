begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
\ir fixtures/factory_improvement_publication.psql

insert into public.factories(id, workspace_id, name, slug, is_default)
select pg_temp.live_id(370), workspace_id, 'Other factory', 'other-publication-factory', false
from live_scope;
insert into public.github_repositories(id, workspace_id, factory_id, github_installation_id, repo_id, name,
  full_name, private, html_url, default_branch)
select pg_temp.live_id(371), workspace_id, pg_temp.live_id(370), pg_temp.live_id(35), 62300371,
  'other-config', 'fixture/other-config', true, 'https://github.com/fixture/other-config', 'main'
from live_scope;

create function pg_temp.set_publication_target(
  p_repository uuid default pg_temp.live_id(360),
  p_branch text default 'wallie/smoke/improvement-base',
  p_actor uuid default pg_temp.live_id(1)
) returns jsonb language sql as $$
  select public.set_factory_improvement_publication_target(workspace_id, factory_id, p_actor, p_repository, p_branch)
  from live_scope;
$$;

create function pg_temp.claim_publication(p_actor uuid default pg_temp.live_id(1))
returns jsonb language sql as $$
  select public.claim_factory_improvement_publication(workspace_id, factory_id, p_actor,
    pg_temp.live_id(300), pg_temp.live_id(312)) from live_scope;
$$;

create function pg_temp.read_publication(p_actor uuid default pg_temp.live_id(1))
returns jsonb language sql as $$
  select public.get_factory_improvement_publication(workspace_id, factory_id, p_actor,
    pg_temp.live_id(300), pg_temp.live_id(312)) from live_scope;
$$;

select throws_ok($$select pg_temp.set_publication_target(p_actor => pg_temp.live_id(999))$$, '42501', null,
  'only a current factory manager can bind the configuration repository');
select throws_ok($$select pg_temp.set_publication_target(p_repository => pg_temp.live_id(371))$$, 'PT422', null,
  'a live repository in another factory of the same installation cannot become the configuration target');
select throws_ok($$select pg_temp.set_publication_target(p_branch => 'main')$$, 'PT422', null,
  'the repository default branch cannot become the improvement publication base');
select lives_ok($$select pg_temp.set_publication_target()$$, 'a manager binds the separate configuration repository');
select throws_ok($$select pg_temp.claim_publication(pg_temp.live_id(999))$$, '42501', null,
  'an unrelated actor cannot request publication');
select throws_ok($$select pg_temp.claim_publication()$$, 'PT422', null,
  'a pending paired benchmark cannot reserve a publication');
select is(pg_temp.read_publication(), null::jsonb, 'an unqualified claim has no publication receipt');

-- A new statement timestamp lets the judge reconciler observe newly finished attempts.
select pg_temp.execute_publication_fixture(true);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score(p_fail_position => 1);
select pg_temp.execute_publication_fixture(false);
select public.reconcile_factory_benchmark_evaluations(100);
select pg_temp.frontier_score();
select is((select public.get_factory_improvement_validation(workspace_id, factory_id, owner_id,
  pg_temp.live_id(300), pg_temp.live_id(312))->>'status' from live_scope), 'qualified',
  'publication uses a real qualified targeted improvement with a held-out nonregression');

create temp table publication_claim as select pg_temp.claim_publication() as receipt;
create function pg_temp.advance_publication(p_action text, p_values jsonb default '{}', p_claim uuid default null)
returns jsonb language sql as $$
  select public.advance_factory_improvement_publication(scope.workspace_id, scope.factory_id, scope.owner_id,
    (state.receipt#>>'{publication,id}')::uuid, coalesce(p_claim, (state.receipt#>>'{claim,id}')::uuid), p_action, p_values)
  from live_scope scope cross join publication_claim state;
$$;

select ok(state.receipt->>'status' = 'claimed'
  and (state.receipt#>>'{claim,id}')::uuid is not null
  and state.receipt#>>'{publication,validationId}' = validation.receipt->>'id'
  and state.receipt#>>'{publication,proposalRevisionId}' = pg_temp.live_id(312)::text
  and state.receipt#>>'{publication,base,digest}' = proposal.base_digest
  and state.receipt#>>'{publication,candidate,digest}' = proposal.candidate_digest
  and state.receipt#>>'{publication,target,repositoryId}' = pg_temp.live_id(360)::text
  and state.receipt#>>'{publication,target,baseBranch}' = 'wallie/smoke/improvement-base'
  and state.receipt#>>'{publication,comparisons,targeted,experimentId}' = validation.receipt#>>'{targeted,experimentId}'
  and state.receipt#>>'{publication,comparisons,holdout,experimentId}' = validation.receipt#>>'{holdout,experimentId}',
  'one publication binds the exact qualified proposal, two experiments, and configuration repository')
from publication_claim state cross join publication_validation validation
join internal.factory_improvement_proposal_revisions proposal on proposal.id = pg_temp.live_id(312);

select ok(retry.receipt->>'status' = 'busy' and retry.receipt#>>'{publication,id}' = state.receipt#>>'{publication,id}'
  and retry.receipt->>'claim' is null, 'a second caller cannot acquire the same live publication lease')
from publication_claim state cross join lateral (select pg_temp.claim_publication()) retry(receipt);
select throws_ok($$select pg_temp.read_publication(pg_temp.live_id(999))$$, '42501', null,
  'an unrelated actor cannot read published or pending receipts');
select throws_ok($$select pg_temp.advance_publication('release', p_claim => pg_temp.live_id(999))$$, 'PT409', null,
  'a nonmatching lease cannot advance the publication');

select is(pg_temp.advance_publication('freeze_base', jsonb_build_object(
  'baseCommitSha', repeat('a',40), 'baseTreeSha', repeat('b',40)))->>'baseCommitSha', repeat('a',40),
  'the publisher durably freezes the observed Git base');
select is(pg_temp.advance_publication('pin_head', jsonb_build_object(
  'headCommitSha', repeat('c',40), 'headTreeSha', repeat('d',40)))->>'headCommitSha', repeat('c',40),
  'the computed Git head is pinned before ref creation');
select lives_ok($$select pg_temp.advance_publication('authorize_head')$$, 'the current exact lease authorizes creating the pinned head');
select throws_ok($$select pg_temp.advance_publication('record_pr',
  '{"pullNumber":592,"pullUrl":"https://github.com/fixture/improvement-config/pull/592","pullState":"open"}')$$, 'PT409', null,
  'a pull request cannot be recorded before the exact create attempt is armed');

create function pg_temp.try_publication_advance(p_action text, p_values jsonb default '{}') returns text language plpgsql as $$
begin
  perform pg_temp.advance_publication(p_action,p_values);
  return '00000';
exception when others then return sqlstate;
end;
$$;

create function pg_temp.try_publication_claim() returns text language plpgsql as $$
begin
  perform pg_temp.claim_publication();
  return '00000';
exception when others then return sqlstate;
end;
$$;
savepoint before_dismissed_proposal;
select public.save_factory_improvement_review_event(workspace_id, factory_id, owner_id,
  pg_temp.live_id(300), pg_temp.live_id(312), 0, gen_random_uuid(), 'dismiss', 'Dismiss the tested draft')
from live_scope;
select pg_temp.try_publication_advance('arm_create') as dismissed_action_state \gset
select pg_temp.advance_publication('release');
select pg_temp.try_publication_claim() as dismissed_claim_state \gset
rollback to savepoint before_dismissed_proposal;
release savepoint before_dismissed_proposal;
select is(:'dismissed_action_state'::text, 'PT409', 'dismissing a proposal fences an existing lease before GitHub creation');
select is(:'dismissed_claim_state'::text, 'PT409', 'a dismissed proposal cannot start a new publication attempt');

savepoint before_superseded_proposal;
select pg_temp.validation_proposal_revision(3, 103);
select pg_temp.try_publication_advance('arm_create') as stale_action_state \gset
rollback to savepoint before_superseded_proposal;
release savepoint before_superseded_proposal;
select is(:'stale_action_state'::text, 'PT409', 'a superseded proposal cannot arm an external create');

savepoint before_rebound_target;
select pg_temp.set_publication_target(p_branch => 'wallie/smoke/another-base');
select pg_temp.try_publication_advance('arm_create') as rebound_target_state \gset
rollback to savepoint before_rebound_target;
release savepoint before_rebound_target;
select is(:'rebound_target_state'::text, 'PT409', 'changing the configuration target fences the old publication');

savepoint before_revoked_evidence;
insert into public.session_retained_content_erasures(session_id,workspace_id,factory_id,archived_at,actor_member_id)
select pg_temp.live_id(2003), workspace_id, factory_id, statement_timestamp(), pg_temp.live_id(21) from live_scope;
select pg_temp.try_publication_advance('arm_create') as revoked_evidence_state \gset
rollback to savepoint before_revoked_evidence;
release savepoint before_revoked_evidence;
select is(:'revoked_evidence_state'::text, 'PT422', 'revoked holdout evidence prevents arming the GitHub write');

savepoint before_creation_reset;
select pg_temp.advance_publication('reset_create');
select pg_temp.try_publication_advance('arm_create') as late_initial_arm_state \gset
update publication_claim set receipt = pg_temp.claim_publication();
select (receipt->>'status' = 'claimed' and receipt#>>'{publication,creationArmed}' = 'false'
  and receipt->>'candidateDefinitionJson' is not null) as safe_retry_claim from publication_claim \gset
select pg_temp.advance_publication('arm_create');
select pg_temp.advance_publication('reset_create');
select pg_temp.try_publication_advance('arm_create') as late_reset_arm_state \gset
rollback to savepoint before_creation_reset;
release savepoint before_creation_reset;
select ok(:'safe_retry_claim'::boolean and :'late_initial_arm_state' = 'PT409',
  'reset fences an unacknowledged arm and permits a fresh unarmed claim');
select is(:'late_reset_arm_state'::text, 'PT409', 'reset of a known safe failure invalidates the arming lease atomically');

select ok(pg_temp.advance_publication('arm_create')->>'creationArmed' = 'true', 'a single durable create attempt is armed');
select throws_ok($$select pg_temp.advance_publication('arm_create')$$, 'PT409', null,
  'a second external POST cannot be armed while the first is unresolved');

savepoint before_historical_recovery;
select pg_temp.advance_publication('release');
select pg_temp.validation_proposal_revision(3, 103);
update publication_claim set receipt = pg_temp.claim_publication();
select (receipt->>'status' = 'claimed' and receipt#>>'{publication,creationArmed}' = 'true'
  and receipt#>>'{publication,current}' = 'false' and receipt->>'candidateDefinitionJson' is null) as historical_claim
from publication_claim \gset
select pg_temp.try_publication_advance('arm_create') as historical_arm_state \gset
select (pg_temp.advance_publication('record_pr',
  '{"pullNumber":592,"pullUrl":"https://github.com/fixture/improvement-config/pull/592","pullState":"open"}')
  @> '{"current":false,"pullRequest":{"number":592,"state":"open"}}') as historical_published \gset
rollback to savepoint before_historical_recovery;
release savepoint before_historical_recovery;
select ok(:'historical_claim'::boolean and :'historical_arm_state' = 'PT409' and :'historical_published'::boolean,
  'an armed historical publication can recover its PR without exposing candidate bytes or arming another POST');

savepoint before_rebound_recovery;
select pg_temp.advance_publication('release');
select pg_temp.set_publication_target(p_repository => pg_temp.live_id(42), p_branch => 'wallie/smoke/rebound-base');
update publication_claim set receipt = pg_temp.claim_publication();
select (receipt->>'status' = 'claimed' and receipt#>>'{publication,creationArmed}' = 'true'
  and receipt#>>'{publication,current}' = 'false' and receipt->>'candidateDefinitionJson' is null
  and receipt#>>'{publication,target,repositoryId}' = pg_temp.live_id(360)::text
  and receipt#>>'{publication,target,baseBranch}' = 'wallie/smoke/improvement-base') as rebound_recovery_claim
from publication_claim \gset
select pg_temp.try_publication_advance('arm_create') as rebound_recovery_arm_state,
  pg_temp.try_publication_advance('authorize_head') as rebound_recovery_head_state,
  pg_temp.try_publication_advance('reset_create') as rebound_recovery_reset_state \gset
select (pg_temp.advance_publication('record_pr',
  '{"pullNumber":592,"pullUrl":"https://github.com/fixture/improvement-config/pull/592","pullState":"draft"}')
  @> '{"current":false,"pullRequest":{"number":592,"state":"draft"}}') as rebound_draft_receipt \gset
rollback to savepoint before_rebound_recovery;
release savepoint before_rebound_recovery;
select ok(:'rebound_recovery_claim'::boolean and :'rebound_recovery_arm_state' = 'PT409'
  and :'rebound_recovery_head_state' = 'PT409' and :'rebound_recovery_reset_state' = 'PT409',
  'a replacement target permits only read-only recovery against the exact originally armed repository');
select ok(:'rebound_draft_receipt'::boolean, 'read-only recovery accepts and records the verified draft PR');

savepoint before_archived_source_repository;
select pg_temp.advance_publication('release');
select pg_temp.set_publication_target(p_repository => pg_temp.live_id(42), p_branch => 'wallie/smoke/rebound-base');
update public.github_repositories set is_archived = true where id = pg_temp.live_id(360);
select pg_temp.try_publication_claim() as archived_original_state \gset
rollback to savepoint before_archived_source_repository;
release savepoint before_archived_source_repository;
select is(:'archived_original_state'::text, 'PT409', 'archiving the originally armed repository blocks recovery even after rebind');

savepoint before_suspended_source_installation;
update public.github_installations set suspended = true where id = pg_temp.live_id(35);
select pg_temp.try_publication_advance('record_pr',
  '{"pullNumber":592,"pullUrl":"https://github.com/fixture/improvement-config/pull/592","pullState":"draft"}')
  as suspended_original_record_state \gset
select pg_temp.advance_publication('release');
select pg_temp.try_publication_claim() as suspended_original_claim_state \gset
rollback to savepoint before_suspended_source_installation;
release savepoint before_suspended_source_installation;
select ok(:'suspended_original_record_state' = 'PT409' and :'suspended_original_claim_state' = 'PT409',
  'suspending the original installation blocks both receipt recording and reacquisition');

create temp table previous_publication_claim as select receipt from publication_claim;
select pg_temp.advance_publication('release');
update publication_claim set receipt = pg_temp.claim_publication();
select ok(state.receipt->>'status' = 'claimed'
  and state.receipt#>>'{claim,id}' <> previous.receipt#>>'{claim,id}'
  and state.receipt#>>'{publication,id}' = previous.receipt#>>'{publication,id}'
  and state.receipt#>>'{publication,baseCommitSha}' = repeat('a',40)
  and state.receipt#>>'{publication,headCommitSha}' = repeat('c',40)
  and state.receipt#>>'{publication,creationArmed}' = 'true',
  'recovery acquires a new lease without changing the pins or resetting an ambiguous POST')
from publication_claim state cross join previous_publication_claim previous;
select throws_ok($$select pg_temp.advance_publication('release', p_claim =>
  (select (receipt#>>'{claim,id}')::uuid from previous_publication_claim))$$, 'PT409', null,
  'the previous lease cannot overwrite the resumed publication');

create temp table published_receipt as select pg_temp.advance_publication('record_pr',
  '{"pullNumber":592,"pullUrl":"https://github.com/fixture/improvement-config/pull/592","pullState":"open"}') as receipt;
select ok(receipt->'pullRequest' @> '{"number":592,"url":"https://github.com/fixture/improvement-config/pull/592","state":"open"}',
  'the recovered exact GitHub PR becomes the durable receipt') from published_receipt;
select ok(retry.receipt->>'status' = 'published'
  and retry.receipt->'publication' = stored.receipt and pg_temp.read_publication() = stored.receipt
  and retry.receipt->>'claim' is null, 'retry and read return the same published PR without a new lease')
from published_receipt stored cross join lateral (select pg_temp.claim_publication()) retry(receipt);
select ok((select count(*) = 2 and bool_and((activation_number, revision_id) in ((1, pg_temp.live_id(101)), (2, pg_temp.live_id(161))))
  from public.factory_definition_activations where workspace_id = pg_temp.live_id(11)),
  'publishing a candidate leaves the original activation and running pins intact');

select * from finish();
rollback;
