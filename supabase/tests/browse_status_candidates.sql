begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

set local request.jwt.claim.role = 'service_role';
set local role service_role;

insert into public.sessions (id, workspace_id, factory_id, pipeline_id, current_stage_id,
  number, title, phase_status, updated_at, archived_at)
select ('46100000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  p.workspace_id, p.factory_id, p.id, ps.id, n, 'Browse status candidate proof ' || n,
  phase::public.pipeline_phase_status, '2026-11-01 10:00:00+00',
  case when archived then '2026-11-01 11:00:00+00'::timestamptz end
from public.pipelines p
join public.pipeline_stages ps on ps.pipeline_id = p.id and ps.slug = 'plan'
cross join (values
  (101, 'awaiting_review', false),
  (102, 'awaiting_review', false),
  (103, 'awaiting_review', false),
  (104, 'in_progress', false),
  (105, 'awaiting_review', true),
  (106, 'approved', false),
  (107, 'rejected', false),
  (108, 'in_progress', false)
) fixture(n, phase, archived)
where p.id = 'd1b2c3d4-0001-4000-8000-000000000001';

insert into public.agent_runs (id, workspace_id, session_id, run_type, model_provider, model_name, status, created_at)
select ('46100000-0001-4000-8000-' || lpad(run.n::text, 12, '0'))::uuid,
  s.workspace_id, s.id, 'stage', 'codex', 'fixture', run.status::public.agent_run_status,
  '2026-11-01 09:00:00+00'::timestamptz + make_interval(mins => run.minute)
from (values
  (102, 1, 'error', 0),
  (102, 2, 'running', 1),
  (103, 3, 'success', 1),
  (103, 4, 'error', 1),
  (104, 5, 'error', 1),
  (106, 6, 'success', 1),
  (108, 7, 'queued', 1)
) run(session_number, n, status, minute)
join public.sessions s on s.number = run.session_number
  and s.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = 'a1b2c3d4-0001-4000-8000-000000000001';

create temporary table browse_status_results as
select status,
  (select lane from jsonb_array_elements(public.get_filtered_pipeline_dashboard_page(
    'b1b2c3d4-0001-4000-8000-000000000001', search_query => 'Browse status candidate proof', status_filter => status
  )->'lanes') lane where lane->>'slug' = 'plan' and lane#>>'{pipeline,isDefault}' = 'true') as board,
  public.get_session_list_page('acme-corp', search_query => 'Browse status candidate proof', status_filter => status) as ledger
from (values (null::text), ('awaiting_review'), ('in_progress'), ('approved'), ('rejected'), ('failed'), ('unknown')) selection(status);

select results_eq($$
  select coalesce(status, 'unfiltered'), jsonb_path_query_array(board, '$.cards[*].number'),
    jsonb_path_query_array(ledger, '$.sessions[*].number')
  from browse_status_results order by 1
$$, $$values
  ('approved', '[106]'::jsonb, '[106]'::jsonb),
  ('awaiting_review', '[102,101]'::jsonb, '[105,102,101]'::jsonb),
  ('failed', '[103,104]'::jsonb, '[104,103]'::jsonb),
  ('in_progress', '[108]'::jsonb, '[108]'::jsonb),
  ('rejected', '[107]'::jsonb, '[107]'::jsonb),
  ('unfiltered', '[103,102,101,108,107,106,104]'::jsonb, '[108,107,106,105,104,103,102,101]'::jsonb),
  ('unknown', '[]'::jsonb, '[108,107,106,105,104,103,102,101]'::jsonb)
$$, 'both invoker RPCs keep latest-error overrides, archives, ties and their own invalid-filter behavior');

select is(jsonb_path_query_array(board, '$.cards[*].latestRunStatus'), '["running",null]'::jsonb,
  'Pipeline retains a newer retry and a null latest run')
from browse_status_results where status = 'awaiting_review';
select is(jsonb_path_query_array(ledger, '$.sessions[*].latestRunStatus'), '[null,"running",null]'::jsonb,
  'Ledger retains latest-run status for each matching row, including no run')
from browse_status_results where status = 'awaiting_review';

select is(
  (select payload->'lanes'->0 from public.get_filtered_pipeline_dashboard_page(
    'b1b2c3d4-0001-4000-8000-000000000001',
    target_pipeline_id => (board#>>'{pipeline,id}')::uuid,
    target_stage_id => (board->>'id')::uuid,
    page_limit => 1, cursor_seen_ids => array[(board#>>'{cards,0,id}')::uuid],
    search_query => 'Browse status candidate proof', status_filter => 'awaiting_review'
  ) payload),
  board || jsonb_build_object('cards', jsonb_build_array(board#>'{cards,1}'), 'cursor', null),
  'a filtered lane continuation preserves counts and leaves the correct tied card')
from browse_status_results where status = 'awaiting_review';
select is(
  jsonb_build_array(board->'totalCount', board->'activeCount'),
  jsonb_build_array(2, (select count(*) from public.sessions s
    where s.current_stage_id = (board->>'id')::uuid and s.archived_at is null)),
  'Pipeline counts the full active lane separately from the filtered total')
from browse_status_results where status = 'awaiting_review';

create temporary table browse_active_page as
select public.get_session_list_page('acme-corp', session_scope => 'active', page_limit => 1,
  search_query => 'Browse status candidate proof', status_filter => 'awaiting_review') as first_page;

select is(jsonb_build_array(first_page#>'{sessions,0,number}', first_page->'hasMore'), '[102,true]'::jsonb,
  'Ledger limits the first filtered active page and sets hasMore')
from browse_active_page;
select is(
  (select payload from public.get_session_list_page('acme-corp',
    session_scope => 'active', page_limit => 1,
    cursor_updated_at => (first_page#>>'{sessions,0,updatedAt}')::timestamptz,
    cursor_id => (first_page#>>'{sessions,0,id}')::uuid,
    search_query => 'Browse status candidate proof', status_filter => 'awaiting_review'
  ) payload),
  first_page || jsonb_build_object('hasMore', false, 'sessions', jsonb_build_array(ledger#>'{sessions,2}')),
  'updated-order cursor traverses the timestamp tie without changing filtered facets')
from browse_active_page cross join browse_status_results where status = 'awaiting_review';
select is(
  jsonb_build_array(first_page->'scopeFacets', first_page#>'{stageFacets,0,count}'),
  '[{"active":2,"archived":1,"all":3},2]'::jsonb,
  'Ledger scope facets include archived matches while the stage facet follows the active scope'
)
from browse_active_page;
select is(
  public.get_session_list_page('acme-corp', session_scope => 'archived',
    search_query => '#105', status_filter => 'awaiting_review')#>>'{sessions,0,number}',
  '105', 'a matching no-run session remains searchable in the archive'
);

reset role;
select * from finish();
rollback;
