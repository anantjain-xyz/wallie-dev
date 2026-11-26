begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id, email) values
  ('46000000-0001-4000-8000-000000000001', 'pipeline-owner@example.test'),
  ('46000000-0001-4000-8000-000000000002', 'pipeline-member@example.test'),
  ('46000000-0001-4000-8000-000000000003', 'pipeline-outsider@example.test');

set local request.jwt.claim.role = 'service_role';
set local role service_role;
insert into public.workspaces(id, slug, name) values
  ('46000000-0000-4000-8000-000000000001', 'pipeline-filter-test', 'Pipeline filter test');
insert into public.workspace_members(id, workspace_id, user_id, kind, role) values
  ('46000000-0002-4000-8000-000000000001', '46000000-0000-4000-8000-000000000001',
    '46000000-0001-4000-8000-000000000001', 'human', 'owner'),
  ('46000000-0002-4000-8000-000000000002', '46000000-0000-4000-8000-000000000001',
    '46000000-0001-4000-8000-000000000002', 'human', 'member');
select public.create_factory(
  '46000000-0000-4000-8000-000000000001', '46000000-0001-4000-8000-000000000001',
  'Customer tools', 'customer-tools'
);

create temporary table pipeline_scope as
select f.workspace_id, f.id as factory_id, f.is_default,
  case when f.is_default then '46000000-0003-4000-8000-000000000001'::uuid
    else '46000000-0003-4000-8000-000000000002'::uuid end as pipeline_id,
  case when f.is_default then '46000000-0004-4000-8000-000000000001'::uuid
    else '46000000-0004-4000-8000-000000000002'::uuid end as stage_id
from public.factories f
where f.workspace_id = '46000000-0000-4000-8000-000000000001';
grant select on pipeline_scope to authenticated;

insert into public.pipelines(id, workspace_id, factory_id, name)
select s.pipeline_id, s.workspace_id, s.factory_id, 'Custom workflow' from pipeline_scope s;
insert into public.pipeline_stages(id, workspace_id, pipeline_id, position, slug, name)
select s.stage_id, s.workspace_id, s.pipeline_id, 1, 'plan', 'Plan' from pipeline_scope s;

insert into public.sessions(
  workspace_id, factory_id, pipeline_id, current_stage_id, number, title, phase_status,
  linear_issue_id, updated_at, creator_member_id
)
select s.workspace_id, s.factory_id, s.pipeline_id, s.stage_id, n,
  case n when 1 then 'Ticket: Fix 100% ratio'
    when 29 then 'Ticket: Customer tools only'
    else 'Ticket: Job ' || n end,
  (case n when 1 then 'rejected' else 'in_progress' end)::public.pipeline_phase_status,
  case n when 1 then 'OP-353' end,
  '2026-01-01T00:00:00Z'::timestamptz + n * interval '1 minute',
  '46000000-0002-4000-8000-000000000001'
from pipeline_scope s
cross join generate_series(1, 29) n
where s.is_default = (n < 29);

insert into public.session_pull_requests(
  workspace_id, session_id, branch_name, pull_request_number, pull_request_url
)
select workspace_id, id, 'synthetic-ratio', 476, 'https://github.com/example/repo/pull/476'
from public.sessions where workspace_id = '46000000-0000-4000-8000-000000000001' and number = 1;
insert into public.agent_runs(
  workspace_id, session_id, stage_id, model_provider, model_name, run_type, status,
  agent_id, agent_prompt_revision_id, triggered_by_member_id, created_at
)
select s.workspace_id, s.id, s.current_stage_id, 'codex', 'synthetic-model', 'research',
  run_status.status, revision.agent_id, revision.id, s.creator_member_id,
  s.updated_at + run_status.age
from public.sessions s
join public.factory_agents agent
  on agent.workspace_id = s.workspace_id and agent.factory_id = s.factory_id and agent.is_default
join public.factory_agent_prompt_revisions revision
  on revision.agent_id = agent.id and revision.revision_number = 1
cross join (values
  ('success'::public.agent_run_status, interval '0 minutes'),
  ('error'::public.agent_run_status, interval '1 minute')
) run_status(status, age)
where s.workspace_id = '46000000-0000-4000-8000-000000000001' and s.number = 1;

set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '46000000-0001-4000-8000-000000000002';

create function pg_temp.pipeline_board_lane(board jsonb)
returns jsonb language sql as $$
  select lane from jsonb_array_elements(board -> 'lanes') lane
  where lane ->> 'id' = '46000000-0004-4000-8000-000000000001';
$$;

create temporary table pipeline_results as
select
  pg_temp.pipeline_board_lane(public.get_pipeline_dashboard_page(s.workspace_id)) as unfiltered,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => 'FIX 100%')) as title,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => '  op-353 ')) as linear,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => '#1', status_filter => 'failed')) as number,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => 'PR #476')) as pr,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => '%')) as literal,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, status_filter => 'failed')) as failed,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, status_filter => 'rejected')) as rejected,
  pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(s.workspace_id, search_query => 'Ticket')) as page_one
from pipeline_scope s where s.is_default;

select is((select jsonb_array_length(unfiltered -> 'cards') from pipeline_results), 25, 'keeps the unfiltered page bounded');
select is((select unfiltered -> 'cards' -> 24 ->> 'number' from pipeline_results), '4', 'the target session is beyond the unfiltered first page');
select is((select title -> 'cards' -> 0 ->> 'number' from pipeline_results), '1', 'finds an off-page title case-insensitively');
select is((select linear -> 'cards' -> 0 ->> 'number' from pipeline_results), '1', 'finds an off-page Linear issue key');
select is((select number -> 'cards' -> 0 ->> 'number' from pipeline_results), '1', 'combines a human session number with a display status');
select is((select pr -> 'cards' -> 0 ->> 'number' from pipeline_results), '1', 'finds an off-page pull request');
select is((select literal ->> 'totalCount' from pipeline_results), '1', 'treats a percent sign as literal text');
select is((select failed -> 'cards' -> 0 ->> 'number' from pipeline_results), '1', 'uses the latest errored run before paging');
select is((select rejected ->> 'totalCount' from pipeline_results), '0', 'a failed card does not also match rejected');
select is((select rejected ->> 'activeCount' from pipeline_results), '28', 'retains the unfiltered count for an occupied lane');

create temporary table pipeline_next_page as
select pg_temp.pipeline_board_lane(public.get_filtered_pipeline_dashboard_page(
  s.workspace_id,
  target_pipeline_id => s.pipeline_id,
  target_stage_id => s.stage_id,
  cursor_seen_ids => array(
    select (card ->> 'id')::uuid from jsonb_array_elements(r.page_one -> 'cards') card
  ),
  search_query => 'ticket'
)) as lane
from pipeline_scope s cross join pipeline_results r where s.is_default;
select is((select page_one ->> 'totalCount' from pipeline_results), '28', 'the first page reports the full matching total');
select isnt((select page_one -> 'cursor' from pipeline_results), 'null'::jsonb, 'a filtered lane with more matches returns a cursor');
select is((select lane ->> 'totalCount' from pipeline_next_page), '28', 'the next filtered page keeps the full matching total');
select is((select jsonb_array_length(lane -> 'cards') from pipeline_next_page), 3, 'the lane continuation returns the remaining matches');
select is((select lane -> 'cards' -> 2 ->> 'number' from pipeline_next_page), '1', 'the filtered continuation preserves ordering');
select is((select lane -> 'cursor' from pipeline_next_page), 'null'::jsonb, 'the last filtered page exhausts the cursor');

select is(
  (select count(*) from jsonb_array_elements(public.get_filtered_pipeline_dashboard_page(
    '46000000-0000-4000-8000-000000000001', search_query => 'ticket'
  ) -> 'lanes') lane where lane ->> 'name' = 'Plan' and lane ->> 'factoryName' = 'Customer tools'),
  0::bigint, 'a restricted member cannot see a sibling factory lane or owner name'
);
set local request.jwt.claim.sub = '46000000-0001-4000-8000-000000000001';
select results_eq($$
  select lane ->> 'factoryName', lane ->> 'totalCount'
  from jsonb_array_elements(public.get_filtered_pipeline_dashboard_page(
    '46000000-0000-4000-8000-000000000001', search_query => 'ticket'
  ) -> 'lanes') lane
  where lane ->> 'name' = 'Plan' and (lane ->> 'totalCount')::int > 0
  order by 1
$$, $$values ('Customer tools', '1'), ('Default factory', '28')$$,
  'an authorized owner sees two distinct same-name stages and their own matching totals'
);
set local request.jwt.claim.sub = '46000000-0001-4000-8000-000000000003';
select is(
  public.get_filtered_pipeline_dashboard_page('46000000-0000-4000-8000-000000000001'),
  null::jsonb, 'an outsider gets no workspace snapshot'
);

select * from finish();
rollback;
