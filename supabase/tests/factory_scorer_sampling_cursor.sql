create extension if not exists pgtap with schema extensions;
create extension if not exists dblink with schema extensions;
select plan(5);
set request.jwt.claim.role = 'service_role';

create temporary table initial_sampling_cursor as select * from internal.factory_scorer_sampling_cursor;

insert into public.workspaces (id, slug, name) values
  ('60300000-5000-4000-8000-000000000001', 'sampling-open-transaction', 'Open transaction fixture'),
  ('60300000-5000-4000-8000-000000000002', 'sampling-committed-transaction', 'Committed transaction fixture');

create function pg_temp.record_completion(p_workspace_id uuid, p_key text) returns void language sql as $$
  select internal.record_factory_outcome_observation(factory.workspace_id, factory.id, 'run.finished',
    'run', p_key, clock_timestamp(), p_status => 'success')
  from public.factories factory where factory.workspace_id = p_workspace_id and factory.is_default
$$;

-- Drain only the committed seed transactions. This fixture has both kinds of
-- observations but no enrolled scorer policies.
do $$
declare previous_id uuid; next_id uuid;
begin
  for batch in 1..20 loop
    select last_observation_id into previous_id from internal.factory_scorer_sampling_cursor;
    perform public.process_factory_scorer_sampling(100);
    select last_observation_id into next_id from internal.factory_scorer_sampling_cursor;
    if previous_id = next_id then return; end if;
  end loop;
  raise exception 'Could not drain seed observations.';
end;
$$;
create temporary table closed_sampling_cursor as select * from internal.factory_scorer_sampling_cursor;

select extensions.dblink_connect('scorer_open', coalesce(nullif(current_setting('wallie.test_db_connection', true), ''),
  'host=supabase_db_wallie-dev port=5432 dbname=postgres user=supabase_admin password=postgres'));
select extensions.dblink_exec('scorer_open', 'begin; set local statement_timeout = ''10s''');
select * from extensions.dblink('scorer_open', $sql$
  select internal.record_factory_outcome_observation(factory.workspace_id, factory.id, 'run.finished',
    'run', 'sampling-opens-first', clock_timestamp(), p_status => 'success')
  from public.factories factory
  where factory.workspace_id = '60300000-5000-4000-8000-000000000001' and factory.is_default
$sql$) as result(recorded text);
select pg_temp.record_completion('60300000-5000-4000-8000-000000000002', 'sampling-commits-first');

select * from public.process_factory_scorer_sampling(1);
select is((select last_observation_id from internal.factory_scorer_sampling_cursor),
  (select last_observation_id from closed_sampling_cursor),
  'a later committed observation waits for an earlier in-flight transaction');
select extensions.dblink_exec('scorer_open', 'commit');
select extensions.dblink_disconnect('scorer_open');

select * from public.process_factory_scorer_sampling(1);
select is((select last_observation_id from internal.factory_scorer_sampling_cursor),
  (select id from internal.factory_outcome_observations where source_key = 'sampling-opens-first'),
  'a one-observation batch does not skip the transaction that committed late');
select * from public.process_factory_scorer_sampling(1);
select is((select last_observation_id from internal.factory_scorer_sampling_cursor),
  (select id from internal.factory_outcome_observations where source_key = 'sampling-commits-first'),
  'the next batch continues from the exact closed transaction and observation');
select * from public.process_factory_scorer_sampling(1);
select is((select last_observation_id from internal.factory_scorer_sampling_cursor),
  (select id from internal.factory_outcome_observations where source_key = 'sampling-commits-first'),
  'polling again does not repeat a processed completion');
select is((select count(*) from public.factory_scorer_sample_receipts
    where workspace_id in ('60300000-5000-4000-8000-000000000001', '60300000-5000-4000-8000-000000000002')),
  0::bigint, 'a completion without a pinned scorer policy still advances the cursor without a receipt');

update internal.factory_scorer_sampling_cursor cursor
set last_xact_id = initial.last_xact_id, last_observation_id = initial.last_observation_id
from initial_sampling_cursor initial;
delete from public.workspaces
where id in ('60300000-5000-4000-8000-000000000001', '60300000-5000-4000-8000-000000000002');
reset request.jwt.claim.role;
select * from finish();
