begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
set local request.jwt.claim.role = 'service_role';
\ir fixtures/factory_improvement_adoption.psql

select ok(has_function_privilege('service_role',
  'public.adopt_factory_improvement(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text[],text[])','execute')
  and not has_function_privilege('authenticated',
  'public.adopt_factory_improvement(uuid,uuid,uuid,uuid,uuid,uuid,bigint,text,text,text,jsonb,text[],text[])','execute')
  and not has_table_privilege('service_role','internal.factory_improvement_adoptions','insert'),
  'only the trusted service can submit hosted review proof');

select throws_ok($$select pg_temp.adopt_fixture(p_expected => 1)$$,'PT409',null,
  'a stale active base cannot be replaced');
select throws_ok($$select pg_temp.adopt_fixture(p_head => repeat('f',40))$$,'PT409',null,
  'the displayed GitHub head must match the recorded publication');
select throws_ok($$select pg_temp.adopt_fixture(p_review => '{}')$$,'PT422',null,
  'a digest or publication record alone cannot supply a merged human review');
select throws_ok($$select pg_temp.adopt_fixture(p_review => jsonb_set(pg_temp.adoption_review(),
  '{headCommitSha}',to_jsonb(repeat('f',40))))$$,'PT422',null,
  'a proof of approval on a force-pushed head is rejected');
select throws_ok($$select pg_temp.adopt_fixture(p_review => jsonb_set(pg_temp.adoption_review(),
  '{observedAt}',to_jsonb(statement_timestamp() - interval '3 minutes')))$$,'PT422',null,
  'an expired or inconsistent hosted proof is rejected');
select throws_ok($$select pg_temp.adopt_fixture(p_reviewed_bytes =>
  (select definition_json || chr(10) from public.factory_definition_revisions where id = pg_temp.live_id(162)))$$,'PT422',null,
  'the authorized remote definition must match the exact candidate bytes');

insert into auth.users(id,email)
values (pg_temp.live_id(640),'improvement-adoption-revoked@example.test');
insert into public.workspace_members(workspace_id,user_id,kind,role,is_active)
select workspace_id,pg_temp.live_id(640),'human','admin',false from live_scope;
select throws_ok($$select pg_temp.adopt_fixture(p_actor => pg_temp.live_id(640))$$,'42501',null,
  'a revoked workspace manager cannot act on the externally reviewed candidate');

create function pg_temp.try_fixture_adoption() returns text language plpgsql as $$
begin
  perform pg_temp.adopt_fixture();
  return '00000';
exception when others then return sqlstate;
end;
$$;
savepoint before_holdout_erasure;
insert into public.session_retained_content_erasures(session_id,workspace_id,factory_id,archived_at,actor_member_id)
select pg_temp.live_id(2003),workspace_id,factory_id,statement_timestamp(),pg_temp.live_id(21) from live_scope;
select pg_temp.try_fixture_adoption() as erased_adoption_state \gset
rollback to before_holdout_erasure;
release savepoint before_holdout_erasure;
select is(:'erased_adoption_state'::text,'PT422','the exact holdout must still be qualified at activation');
select is((select max(activation_number) from public.factory_definition_activations activation
  join live_scope scope on (scope.workspace_id,scope.factory_id) = (activation.workspace_id,activation.factory_id)),2::bigint,
  'failed adoption checks leave the active factory unchanged');

select public.set_git_continuity_release(true,revision,'Transactional improvement admission fixture')
from public.get_git_continuity_release_state() where not enabled;
insert into internal.workspace_issue_counters(workspace_id,last_issue_number)
select scope.workspace_id,max(session.number) from live_scope scope
join public.sessions session on session.workspace_id = scope.workspace_id group by scope.workspace_id
on conflict (workspace_id) do update set last_issue_number = excluded.last_issue_number;
create function pg_temp.admit_improvement_session(p_request_id uuid,p_title text)
returns uuid language sql as $$
  select admitted.session_id from live_scope scope cross join lateral public.create_session_once_with_first_job(
    scope.workspace_id,pg_temp.live_id(21),p_request_id,repeat('1',64),p_title,'A frozen user prompt.',
    'codex','gpt-4.1-2025-04-14','{}'::uuid[],
    session_github_repository_id => pg_temp.live_id(42),selected_pipeline_id => pg_temp.live_id(40),
    selected_stage_ids => array[pg_temp.live_id(41)]) admitted;
$$;
create temp table improvement_prior_session as
select pg_temp.admit_improvement_session(pg_temp.live_id(641),'Admission before reviewed improvement') as session_id;
create temp table improvement_prior_pin as
select to_jsonb(input) as pin,to_jsonb(session) as session_snapshot
from public.session_factory_admission_inputs input join improvement_prior_session prior using (session_id)
join public.sessions session on session.id = prior.session_id;

create temp table accepted_improvement as select pg_temp.adopt_fixture() as result;
select ok((select result @> '{"replay":false,"adoption":{"baseline":{"activationNumber":2},
  "adopted":{"activationNumber":3},"review":{"pullNumber":640},"comparisons":{"targeted":{"status":"qualified"},
  "holdout":{"status":"qualified"}}}}'
  and result#>>'{adoption,adopted,revisionId}' = pg_temp.live_id(162)::text
  and result#>>'{adoption,actorMemberId}' = pg_temp.live_id(21)::text from accepted_improvement),
  'adoption appends the exact tested revision and independently authorized GitHub identity');
select is((select public.get_factory_improvement_adoption(scope.workspace_id,scope.factory_id,scope.owner_id,
  pg_temp.live_id(300),pg_temp.live_id(312)) from live_scope scope), (select result->'adoption' from accepted_improvement),
  'the exact revision returns its durable paired evidence and activation receipt');
select ok((select replay.result @> '{"replay":true}' and replay.result->'adoption' = first.result->'adoption'
  from (select pg_temp.adopt_fixture(p_review => '{}') as result) replay cross join accepted_improvement first),
  'an exact retry returns the existing receipt without another GitHub decision or activation');
select is((select count(*) from internal.factory_improvement_adoptions),1::bigint,
  'the scoped proposal revision has a single adoption receipt');
select is((select max(activation_number) from public.factory_definition_activations activation
  join live_scope scope on (scope.workspace_id,scope.factory_id) = (activation.workspace_id,activation.factory_id)),3::bigint,
  'replay does not advance the factory a second time');

create temp table improvement_next_session as
select pg_temp.admit_improvement_session(pg_temp.live_id(642),'Admission after reviewed improvement') as session_id;
select ok((select input.activation_number = 3 and input.definition_revision_id = pg_temp.live_id(162)
  and input.definition_digest = (first.result#>>'{adoption,adopted,digest}')
  from public.session_factory_admission_inputs input join improvement_next_session session using (session_id)
  cross join accepted_improvement first),'new admissions use the exact tested candidate activation');
select is((select to_jsonb(input) from public.session_factory_admission_inputs input
  join improvement_prior_session session using (session_id)),(select pin from improvement_prior_pin),
  'previous admissions retain their exact pinned input and configuration');
select is((select to_jsonb(session) from public.sessions session
  join improvement_prior_session prior on prior.session_id = session.id),(select session_snapshot from improvement_prior_pin),
  'an existing session retains its original definition revision and review state');
select * from finish();
rollback;
