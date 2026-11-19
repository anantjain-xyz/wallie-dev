begin;
create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(8);
set local request.jwt.claim.role = 'service_role';

create function pg_temp.scorer_backfill_id(slot integer) returns uuid language sql immutable as $$
  select ('60300000-6000-4000-8000-' || lpad(slot::text, 12, '0'))::uuid
$$;

insert into auth.users(id, email)
values (pg_temp.scorer_backfill_id(1), 'scorer-backfill-race@example.test');
insert into public.workspaces(id, slug, name)
values (pg_temp.scorer_backfill_id(2), 'scorer-backfill-race', 'Scorer backfill race');
insert into public.workspace_members(id, workspace_id, user_id, kind, role)
values (pg_temp.scorer_backfill_id(3), pg_temp.scorer_backfill_id(2), pg_temp.scorer_backfill_id(1), 'human', 'owner');
insert into public.pipelines(id, workspace_id, name)
values (pg_temp.scorer_backfill_id(4), pg_temp.scorer_backfill_id(2), 'Scorer backfill pipeline');
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
values (pg_temp.scorer_backfill_id(5), pg_temp.scorer_backfill_id(2), pg_temp.scorer_backfill_id(4), 1, 'review', 'Review');

create temp table scorer_backfill_fixture as
select factory.workspace_id, factory.id as factory_id, scorer.id as scorer_revision_id,
  pg_temp.scorer_backfill_id(6) as definition_id, pg_temp.scorer_backfill_id(7) as session_id,
  pg_temp.scorer_backfill_id(5) as stage_id, clock_timestamp() as cutoff
from public.factories factory
cross join lateral public.create_factory_scorer(factory.workspace_id, factory.id,
  pg_temp.scorer_backfill_id(1), 'Backfill proof', 'backfill-proof',
  '{"schemaVersion":1,"rubric":"Read the artifact.","requiredEvidence":["artifact"],"scoring":{"kind":"boolean","passValue":true}}'::jsonb) scorer
where factory.workspace_id = pg_temp.scorer_backfill_id(2) and factory.is_default;

insert into public.factory_definition_revisions(
  id, workspace_id, factory_id, schema_version, definition_json, canonical_digest, created_by
)
select fixture.definition_id, fixture.workspace_id, fixture.factory_id, 2, compiled.definition,
  encode(sha256(convert_to(compiled.definition, 'UTF8')), 'hex'), pg_temp.scorer_backfill_id(1)
from scorer_backfill_fixture fixture
cross join lateral (
  select jsonb_build_object('schemaVersion', 2, 'kind', 'serial', 'pipelineId', pg_temp.scorer_backfill_id(4),
    'scorerRevisionIds', jsonb_build_array(fixture.scorer_revision_id))::text as definition
) compiled;

insert into public.sessions(id, workspace_id, factory_id, number, creator_member_id, title, pipeline_id,
  current_stage_id, factory_definition_provenance, factory_definition_revision_id, execute_pinned_definition, created_at)
select session_id, workspace_id, factory_id, 1, pg_temp.scorer_backfill_id(3), 'Pinned scorer backfill session',
  pg_temp.scorer_backfill_id(4), stage_id, 'pinned', definition_id, true, cutoff - interval '5 hours'
from scorer_backfill_fixture;

create temp table scorer_backfill_policy as
select policy.id
from scorer_backfill_fixture fixture
cross join lateral public.save_factory_scorer_sampling_policy(fixture.workspace_id, fixture.factory_id,
  pg_temp.scorer_backfill_id(1), fixture.scorer_revision_id, 0, 10000, 'backfill-race') policy;

insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider,
  model_name, status, attempt_count, started_at, finished_at)
select pg_temp.scorer_backfill_id(target.slot), fixture.workspace_id, fixture.session_id, fixture.stage_id,
  'project', 'codex', 'gpt-5.5', 'success', 1, fixture.cutoff - target.elapsed - interval '1 minute',
  fixture.cutoff - target.elapsed
from scorer_backfill_fixture fixture
cross join (values (11, interval '3 hours'), (13, interval '1 hour')) target(slot, elapsed);
commit;

set request.jwt.claim.role = 'service_role';
create function pg_temp.scorer_backfill_page(p_limit integer, p_finished_at timestamptz default null,
  p_run_id uuid default null, p_cursor text default null)
returns table(candidate_count integer, eligible_count integer, sampled_count integer, excluded_count integer,
  next_finished_at timestamptz, next_run_id uuid, closed_before text) language sql as $$
  select page.* from scorer_backfill_fixture fixture cross join scorer_backfill_policy policy
  cross join lateral public.backfill_factory_scorer_samples(fixture.workspace_id, fixture.factory_id, policy.id,
    fixture.cutoff, p_finished_at, p_run_id, p_limit, p_cursor) page
$$;

select extensions.dblink_connect('scorer_backfill_writer',
  coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('scorer_backfill_writer', $sql$
  set statement_timeout = '10s';
  set request.jwt.claim.role = 'service_role';
  begin;
$sql$);

-- One late run sorts behind the first page and one sorts ahead of its cursor.
-- The second one would displace the committed second-page run without the horizon.
select extensions.dblink_exec('scorer_backfill_writer', format($sql$
  insert into public.agent_runs(id, workspace_id, session_id, stage_id, run_type, model_provider,
    model_name, status, attempt_count, started_at, finished_at)
  select target.id, %L::uuid, %L::uuid, %L::uuid, 'project', 'codex', 'gpt-5.5', 'success', 1,
    target.finished_at - interval '1 minute', target.finished_at
  from (values (%L::uuid, %L::timestamptz), (%L::uuid, %L::timestamptz)) target(id, finished_at)
$sql$, workspace_id, session_id, stage_id,
  pg_temp.scorer_backfill_id(10), cutoff - interval '4 hours',
  pg_temp.scorer_backfill_id(12), cutoff - interval '2 hours')) from scorer_backfill_fixture;

create temp table scorer_backfill_first_page as select * from pg_temp.scorer_backfill_page(1);
select ok((select candidate_count = 1 and eligible_count = 0 and sampled_count = 0 and excluded_count = 1
    and next_run_id = pg_temp.scorer_backfill_id(11) and closed_before is not null
  from scorer_backfill_first_page), 'backfill opens a cohort over the committed terminal observations');
select extensions.dblink_exec('scorer_backfill_writer', 'commit');

select throws_ok($sql$
  select * from scorer_backfill_first_page first cross join lateral
    pg_temp.scorer_backfill_page(1, first.next_finished_at, pg_temp.scorer_backfill_id(10), first.closed_before)
$sql$, '22023', 'Invalid scorer sampling backfill cursor.', 'the token authenticates the exact next position');

select ok((select next.candidate_count = 1 and next.eligible_count = 0 and next.excluded_count = 1
    and next.next_run_id is null and next.closed_before is null
  from scorer_backfill_first_page first cross join lateral
    pg_temp.scorer_backfill_page(1, first.next_finished_at, first.next_run_id, first.closed_before) next),
  'continuing the original cohort ignores even a late commit after the cursor');
select is((select array_agg(receipt.run_id order by receipt.run_finished_at)
  from public.factory_scorer_sample_receipts receipt join scorer_backfill_policy policy on receipt.policy_id = policy.id),
  array[pg_temp.scorer_backfill_id(11), pg_temp.scorer_backfill_id(13)],
  'only the original two runs receive a receipt from the frozen cohort');

select extensions.dblink_connect('scorer_backfill_contender',
  coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
    'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('scorer_backfill_contender', $sql$
  set application_name = 'scorer_backfill_receipt_contender';
  set statement_timeout = '10s';
  set request.jwt.claim.role = 'service_role';
$sql$);
create temp table scorer_backfill_race_query as
select format('select receipt.id from public.record_factory_scorer_sample(%L, %L, %L, %L) receipt',
  fixture.workspace_id, fixture.factory_id, policy.id, pg_temp.scorer_backfill_id(12)) as sql
from scorer_backfill_fixture fixture cross join scorer_backfill_policy policy;

select extensions.dblink_exec('scorer_backfill_writer', 'begin');
create temp table scorer_backfill_winner as
select result.id from scorer_backfill_race_query request cross join lateral
  extensions.dblink('scorer_backfill_writer', request.sql) as result(id uuid);
select extensions.dblink_send_query('scorer_backfill_contender', sql) from scorer_backfill_race_query;
do $$
declare deadline timestamptz := clock_timestamp() + interval '5 seconds';
begin
  loop
    perform pg_stat_clear_snapshot();
    exit when exists (select 1 from pg_stat_activity
      where application_name = 'scorer_backfill_receipt_contender' and wait_event_type = 'Lock');
    if clock_timestamp() >= deadline then
      raise exception 'The concurrent receipt writer did not reach the lock.';
    end if;
    perform pg_sleep(0.01);
  end loop;
end;
$$;
select extensions.dblink_exec('scorer_backfill_writer', 'commit');
select is((select result.id from extensions.dblink_get_result('scorer_backfill_contender') as result(id uuid)),
  (select id from scorer_backfill_winner), 'concurrent exact calls return the same committed receipt');
select is((select count(*) from public.factory_scorer_sample_receipts receipt
    join scorer_backfill_policy policy on receipt.policy_id = policy.id
    where receipt.run_id = pg_temp.scorer_backfill_id(12)),
  1::bigint, 'concurrent callers persist exactly one receipt for a policy and run');
select extensions.dblink_disconnect('scorer_backfill_contender');
select extensions.dblink_disconnect('scorer_backfill_writer');

select ok((select candidate_count = 4 and eligible_count = 0 and sampled_count = 0 and excluded_count = 4
    and next_run_id is null and closed_before is null from pg_temp.scorer_backfill_page(4)),
  'a new cohort includes both newly committed runs');
select is((select array_agg(receipt.reason order by receipt.run_finished_at)
  from public.factory_scorer_sample_receipts receipt join scorer_backfill_policy policy on receipt.policy_id = policy.id),
  array['unsupported_run','unsupported_run','unsupported_run','unsupported_run']::text[],
  'every run without an exact checkpoint remains explicitly excluded');

delete from public.workspaces where id = pg_temp.scorer_backfill_id(2);
delete from auth.users where id = pg_temp.scorer_backfill_id(1);
reset request.jwt.claim.role;
select * from finish();
