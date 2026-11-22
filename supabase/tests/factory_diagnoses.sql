begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
\set diagnosis_fixture_prefix 63500000
\set diagnosis_inference_ciphertext v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA
\ir fixtures/factory_diagnosis_source.psql

create temp table diagnosis_requests(label text primary key, receipt jsonb not null, claim jsonb);
grant select on diagnosis_requests to authenticated;

create function pg_temp.request_diagnosis(p_key integer, p_actor integer default 1) returns jsonb language sql as $$
  select public.request_factory_diagnosis(scope.workspace_id, scope.factory_id, pg_temp.diagnosis_fixture_id(p_actor),
    cohort.id, pg_temp.diagnosis_fixture_id(p_key), agent.id)
  from diagnosis_scope scope cross join diagnosis_cohort cohort cross join diagnosis_agent agent;
$$;

create function pg_temp.prepare_diagnosis(p_label text, p_lease uuid default null) returns jsonb language sql as $$
  select public.prepare_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
    (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, coalesce(p_lease, (claim->>'lease_id')::uuid))
  from diagnosis_requests where label = p_label;
$$;

create function pg_temp.begin_diagnosis(p_label text, p_evidence_digest text default null) returns jsonb language sql as $$
  select public.begin_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
    (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid,
    coalesce(p_evidence_digest, receipt->>'evidence_digest'))
  from diagnosis_requests where label = p_label;
$$;

create function pg_temp.diagnosis_is_current(p_label text) returns boolean language sql as $$
  select public.is_factory_diagnosis_claim_current((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
    (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid)
  from diagnosis_requests where label = p_label;
$$;

create function pg_temp.diagnosis_result(p_label text, p_member_id uuid default null) returns jsonb language sql as $$
  select jsonb_build_object('version', 1, 'summary', 'The exact validation step returned a failure.',
    'uncertainty', 'Only one independent run is available.', 'claims', jsonb_build_array(jsonb_build_object(
      'member_ids', jsonb_build_array(coalesce(p_member_id, (receipt#>>'{evidence,0,member_id}')::uuid)),
      'inferred_cause', 'A regression is possible.', 'uncertainty', 'The log does not isolate the cause.')))
  from diagnosis_requests where label = p_label;
$$;

create function pg_temp.finish_diagnosis(p_label text, p_result jsonb, p_usage jsonb default null) returns boolean language sql as $$
  select public.finish_factory_diagnosis((claim->>'workspace_id')::uuid, (claim->>'factory_id')::uuid,
    (claim->>'diagnosis_id')::uuid, (claim->>'attempt_id')::uuid, (claim->>'lease_id')::uuid, 'completed', p_result,
    '{"provider_model":"openai/gpt-4.1-mini","provider_request_id":"fixture-invocation","worker_runtime":"node"}', p_usage)
  from diagnosis_requests where label = p_label;
$$;

create function pg_temp.read_diagnosis(p_label text) returns jsonb language sql stable as $$
  select public.get_factory_diagnosis((receipt->>'workspace_id')::uuid, (receipt->>'factory_id')::uuid,
    (receipt->>'diagnosis_id')::uuid) from diagnosis_requests where label = p_label;
$$;

select ok(not has_table_privilege('authenticated', 'internal.factory_diagnoses', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_table_privilege('service_role', 'internal.factory_diagnoses', 'SELECT,INSERT,UPDATE,DELETE')
  and not has_function_privilege('authenticated', 'public.begin_factory_diagnosis(uuid,uuid,uuid,uuid,uuid,text)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.get_factory_diagnosis(uuid,uuid,uuid)', 'EXECUTE'),
  'diagnosis history, credentials and dispatch are available only through scoped commands');
select throws_ok($$select pg_temp.request_diagnosis(60, 3)$$, '42501', null,
  'a reader cannot authorize an external diagnosis');
insert into diagnosis_requests(label, receipt) values ('smoke', pg_temp.request_diagnosis(61));
select is(pg_temp.request_diagnosis(61), (select receipt from diagnosis_requests where label = 'smoke'),
  'retrying a human request returns the same frozen diagnosis');
select throws_ok($$select pg_temp.request_diagnosis(61, 2)$$, 'PT409', null,
  'a differing actor cannot repurpose the same idempotency key');
select throws_ok($$select pg_temp.request_diagnosis(62)$$, 'PT409', null,
  'a second human request cannot enqueue parallel work for the same cohort');
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'smoke';
select is(public.claim_factory_diagnosis(), null::jsonb, 'the current claim owns the sole active diagnosis slot');
select is(pg_temp.prepare_diagnosis('smoke', gen_random_uuid()), null::jsonb, 'a mismatched lease cannot read worker inputs');
select ok((select prepared @> jsonb_build_object('agent_id', agent.agent_id, 'prompt_revision_id', agent.id,
    'prompt_sha256', agent.prompt_sha256, 'skill_revision_ids', jsonb_build_array(skill.id),
    'definition_revision_id', pg_temp.diagnosis_fixture_id(51), 'profile_revision_id', provider.id,
    'minimum_support', 3, 'support_count', 1, 'budget', '{"max_execution_ms":60000,"max_output_tokens":1200}'::jsonb,
    'evidence', jsonb_build_array(jsonb_build_object('run_id', source.run_id, 'session_id', source.session_id,
      'stage_id', pg_temp.diagnosis_fixture_id(32), 'stage_slug', 'build', 'validation_record_key', 'tests')))
    and prepared#>>'{evidence,0,producing_agent_id}' <> agent.agent_id::text
    and prepared::text not like '%production-only%'
  from (select pg_temp.prepare_diagnosis('smoke') prepared) input cross join diagnosis_agent agent
  cross join diagnosis_skill skill cross join approved_provider provider cross join diagnosis_source source),
  'the worker sees immutable diagnosis pins and the exact distinct observed producing run and step');
select is(pg_temp.begin_diagnosis('smoke', repeat('d', 64)), null::jsonb,
  'mismatched exact evidence cannot authorize a provider invocation');
select ok(pg_temp.begin_diagnosis('smoke') @> '{"encrypted_api_key":"v2.AAAAAAAAAAAAAAAA.YWJj.AAAAAAAAAAAAAAAAAAAAAA"}',
  'the initial exact worker obtains only the dedicated inference credential');
select is(pg_temp.begin_diagnosis('smoke'), null::jsonb, 'a duplicate worker start cannot spend twice');
select ok(pg_temp.diagnosis_is_current('smoke'), 'the running lease may poll authorization');
select ok(pg_temp.finish_diagnosis('smoke', pg_temp.diagnosis_result('smoke'), '{"input_tokens":500,"output_tokens":50}'),
  'the exact running lease settles a bounded diagnosis with structured uncertainty');
select is(pg_temp.finish_diagnosis('smoke', pg_temp.diagnosis_result('smoke')), false,
  'duplicate provider completion cannot replace terminal results or usage');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63500000-0000-4000-8000-000000000003';
select ok(pg_temp.read_diagnosis('smoke') @> '{"status":"completed","evidence_state":"available",
    "usage":{"input_tokens":500,"output_tokens":50},"result":{"uncertainty":"Only one independent run is available."}}'
    and pg_temp.read_diagnosis('smoke')::text not like '%encrypted_api_key%',
  'an authorized reader can inspect uncertainty and measured usage without worker credentials');
set local request.jwt.claim.sub = '63500000-0000-4000-8000-000000000004';
select throws_ok($$select pg_temp.read_diagnosis('smoke')$$, 'P0002', null, 'other workspaces cannot read diagnosis records');
reset role;
set local request.jwt.claim.role = 'service_role';
set local request.jwt.claim.sub = '';

insert into diagnosis_requests(label, receipt) values ('injected', pg_temp.request_diagnosis(63));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'injected';
select (pg_temp.begin_diagnosis('injected') is not null) as started;
select ok(pg_temp.finish_diagnosis('injected', pg_temp.diagnosis_result('injected', pg_temp.diagnosis_fixture_id(90))),
  'an unsupported attribution settles without publishing the forged result');

insert into diagnosis_requests(label, receipt) values ('budget', pg_temp.request_diagnosis(64));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'budget';
select (pg_temp.begin_diagnosis('budget') is not null) as started;
select ok(pg_temp.finish_diagnosis('budget', pg_temp.diagnosis_result('budget'), '{"output_tokens":1201}'),
  'a provider response over the token cap reaches a bounded terminal state');

insert into diagnosis_requests(label, receipt) values ('canceled', pg_temp.request_diagnosis(65));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'canceled';
select (pg_temp.begin_diagnosis('canceled') is not null) as started;
select ok(public.cancel_factory_diagnosis(scope.workspace_id, scope.factory_id, scope.owner_id, (job.receipt->>'diagnosis_id')::uuid),
  'a current manager can cancel the isolated diagnosis')
from diagnosis_scope scope cross join diagnosis_requests job where job.label = 'canceled';
select ok(not pg_temp.diagnosis_is_current('canceled') and not pg_temp.finish_diagnosis('canceled', pg_temp.diagnosis_result('canceled')),
  'cancellation immediately fences polling and late provider settlement');

insert into diagnosis_requests(label, receipt) values ('expired', pg_temp.request_diagnosis(66));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'expired';
alter table internal.factory_diagnoses disable trigger factory_diagnoses_immutable;
update internal.factory_diagnoses set lease_expires_at = clock_timestamp() - interval '1 second'
where id = (select (receipt->>'diagnosis_id')::uuid from diagnosis_requests where label = 'expired');
alter table internal.factory_diagnoses enable trigger factory_diagnoses_immutable;
select is(public.claim_factory_diagnosis(), null::jsonb, 'an expired worker lease is terminal rather than admitting another paid attempt');
select is(pg_temp.begin_diagnosis('expired'), null::jsonb, 'an expired exact lease cannot acquire a credential afterward');

insert into diagnosis_requests(label, receipt) values ('revoked', pg_temp.request_diagnosis(67, 2));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'revoked';
select public.revoke_factory_membership(workspace_id, factory_id, owner_id, pg_temp.diagnosis_fixture_id(22)) from diagnosis_scope;
select is(pg_temp.begin_diagnosis('revoked'), null::jsonb, 'revoking requester management prevents a claimed dispatch');

insert into diagnosis_requests(label, receipt) values ('withheld', pg_temp.request_diagnosis(68));
update diagnosis_requests set claim = public.claim_factory_diagnosis() where label = 'withheld';
insert into public.session_validation_asset_withholdings(asset_id, state)
select asset_id, 'redacted' from diagnosis_source;
select is(pg_temp.prepare_diagnosis('withheld'), null::jsonb, 'withholding exact source evidence stops pending dispatch');

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '63500000-0000-4000-8000-000000000001';
select ok(pg_temp.read_diagnosis('smoke') @> '{"evidence_state":"unavailable","evidence_digest":null,"evidence":null,"result":null}',
  'the same retention change also redacts already settled diagnosis content');
select is(pg_temp.read_diagnosis('injected')->>'status', 'invalid_result', 'a foreign citation is recorded as invalid, not as a claim');
select is(pg_temp.read_diagnosis('budget')->>'status', 'budget_exhausted', 'an over-budget execution stores no successful result');
select is(pg_temp.read_diagnosis('canceled')->>'status', 'canceled', 'late settlement preserves cancellation');
select is(pg_temp.read_diagnosis('expired')->>'status', 'lease_expired', 'expiry produces a distinct terminal reason');
select is(pg_temp.read_diagnosis('revoked')->>'status', 'authorization_revoked', 'revocation records a distinct terminal reason');
select is(pg_temp.read_diagnosis('withheld')->>'status', 'evidence_unavailable', 'retention records evidence unavailability');
reset role;

select ok((select run.status = 'running' and job.status = 'running' and owner.phase_status = 'in_progress'
  from diagnosis_source source join public.agent_runs run on run.id = source.run_id
  join public.agent_jobs job on job.id = source.job_id join public.sessions owner on owner.id = source.session_id),
  'diagnosis smoke, failures and cancellation never settle the production run, job or review state');
select * from finish();
rollback;
