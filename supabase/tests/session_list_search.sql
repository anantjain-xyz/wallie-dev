begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- All records are local, transaction-only fixtures. The identifier is absent
-- from #42's text, while newer, older and archived sessions mention it.
set local "request.jwt.claim.role" = 'service_role';
set local "request.jwt.claim.sub" = 'a1b2c3d4-0001-4000-8000-000000000001';

insert into public.workspaces (id, slug, name) values
  ('51700000-0001-4000-8000-000000000001', 'session-search-fixture', 'Session search fixture'),
  ('51700000-0001-4000-8000-000000000002', 'session-search-other', 'Other searchable workspace'),
  ('51700000-0001-4000-8000-000000000003', 'session-search-private', 'Inaccessible workspace');

insert into public.workspace_members (workspace_id, user_id, kind, role)
select workspace_id, 'a1b2c3d4-0001-4000-8000-000000000001', 'human', 'owner'
from (values
  ('51700000-0001-4000-8000-000000000001'::uuid),
  ('51700000-0001-4000-8000-000000000002'::uuid)
) fixture(workspace_id);

insert into public.pipelines (id, workspace_id, name)
select workspace_id::text::uuid, workspace_id, 'Search pipeline'
from (values
  ('51700000-0001-4000-8000-000000000001'::uuid),
  ('51700000-0001-4000-8000-000000000002'::uuid),
  ('51700000-0001-4000-8000-000000000003'::uuid)
) fixture(workspace_id);

insert into public.pipeline_stages (id, pipeline_id, workspace_id, position, slug, name) values
  ('51700000-0002-4000-8000-000000000001', '51700000-0001-4000-8000-000000000001', '51700000-0001-4000-8000-000000000001', 1, 'plan', 'Plan'),
  ('51700000-0002-4000-8000-000000000002', '51700000-0001-4000-8000-000000000001', '51700000-0001-4000-8000-000000000001', 2, 'build', 'Build'),
  ('51700000-0002-4000-8000-000000000003', '51700000-0001-4000-8000-000000000002', '51700000-0001-4000-8000-000000000002', 1, 'plan', 'Plan'),
  ('51700000-0002-4000-8000-000000000004', '51700000-0001-4000-8000-000000000003', '51700000-0001-4000-8000-000000000003', 1, 'plan', 'Plan');

insert into public.sessions (
  id, workspace_id, number, title, prompt_md, linear_issue_id,
  pipeline_id, current_stage_id, archived_at, created_at, updated_at
) values
  ('51700000-0003-4000-8000-000000000042', '51700000-0001-4000-8000-000000000001', 42,
   'Inline comments', 'Thread-search-marker', 'OP-517',
   '51700000-0001-4000-8000-000000000001', '51700000-0002-4000-8000-000000000001',
   null, '2026-02-15', '2026-02-15'),
  ('51700000-0003-4000-8000-000000000006', '51700000-0001-4000-8000-000000000001', 6,
   'Unrelated 42 release', 'Comments for release', 'OP-600',
   '51700000-0001-4000-8000-000000000001', '51700000-0002-4000-8000-000000000002',
   null, '2026-03-01', '2026-03-01'),
  ('51700000-0003-4000-8000-000000000008', '51700000-0001-4000-8000-000000000001', 142,
   'Archived migration', 'Comments for migration 42', null,
   '51700000-0001-4000-8000-000000000001', '51700000-0002-4000-8000-000000000002',
   '2026-02-02', '2026-02-01', '2026-02-01'),
  ('51700000-0003-4000-8000-000000000010', '51700000-0001-4000-8000-000000000001', 10,
   'Ordinary title lookup', 'Prompt-only-marker', 'OP-610',
   '51700000-0001-4000-8000-000000000001', '51700000-0002-4000-8000-000000000001',
   null, '2026-04-01', '2026-04-01'),
  ('51700000-0003-4000-8000-000000000142', '51700000-0001-4000-8000-000000000002', 42,
   'Foreign comments 42', 'Thread-search-marker', 'OP-517',
   '51700000-0001-4000-8000-000000000002', '51700000-0002-4000-8000-000000000003',
   null, '2026-05-01', '2026-05-01'),
  ('51700000-0003-4000-8000-000000000242', '51700000-0001-4000-8000-000000000003', 42,
   'Private comments 42', 'Thread-search-marker', 'OP-517',
   '51700000-0001-4000-8000-000000000003', '51700000-0002-4000-8000-000000000004',
   null, '2026-06-01', '2026-06-01');

set local role authenticated;
set local "request.jwt.claim.role" = 'authenticated';

create temp table numeric_search_results as
select query, sort,
  public.get_session_list_page('session-search-fixture', search_query => query, sort_key => sort) payload
from (values ('42'), ('#42'), ('  42  '), (E'\t#42\n'), ('#00042')) queries(query)
cross join (values ('updated'), ('oldest'), ('number')) sorts(sort);

select is(payload->'sessions'->0->>'number', '42', format('%s/%s prioritizes the exact session number', query, sort))
from numeric_search_results;
select is(
  (select jsonb_agg(row->'number') from jsonb_array_elements(payload->'sessions') row),
  case when sort = 'updated' then '[42,6,142]'::jsonb else '[42,142,6]'::jsonb end,
  format('%s/%s retains incidental matches after the exact match in the requested sort', query, sort)
)
from numeric_search_results;
select is(payload->'scopeFacets', '{"active":2,"archived":1,"all":3}'::jsonb,
  format('%s/%s scope counts use identifier plus text matches', query, sort))
from numeric_search_results;
select is(payload->'stageFacets', '[{"count":1,"name":"Plan","position":1,"slug":"plan"},{"count":2,"name":"Build","position":2,"slug":"build"}]'::jsonb,
  format('%s/%s stage counts use identifier plus text matches', query, sort))
from numeric_search_results;
select is(payload->>'hasMore', 'false', format('%s/%s complete result has no further page', query, sort))
from numeric_search_results;

-- Cursor rank must be compared before the selected sort. The exact match is
-- between incidental timestamps and below an incidental session number.
create temp table search_pagination as
with first_page as (
  select query, sort, public.get_session_list_page('session-search-fixture',
    search_query => query, sort_key => sort, page_limit => 1) payload
  from (values ('42'), ('#42')) queries(query)
  cross join (values ('updated'), ('oldest'), ('number')) sorts(sort)
), second_page as (
  select *, public.get_session_list_page('session-search-fixture',
    search_query => query, sort_key => sort, page_limit => 1,
    cursor_id => (payload #>> '{sessions,0,id}')::uuid,
    cursor_number => (payload #>> '{sessions,0,number}')::integer,
    cursor_updated_at => (payload #>> '{sessions,0,updatedAt}')::timestamptz) second_payload
  from first_page
)
select *, public.get_session_list_page('session-search-fixture',
  search_query => query, sort_key => sort, page_limit => 1,
  cursor_id => (second_payload #>> '{sessions,0,id}')::uuid,
  cursor_number => (second_payload #>> '{sessions,0,number}')::integer,
  cursor_updated_at => (second_payload #>> '{sessions,0,updatedAt}')::timestamptz) third_payload
from second_page;

select is(
  jsonb_build_array(payload #> '{sessions,0,number}', second_payload #> '{sessions,0,number}', third_payload #> '{sessions,0,number}'),
  case when sort = 'updated' then '[42,6,142]'::jsonb else '[42,142,6]'::jsonb end,
  format('%s/%s pagination returns the exact match and each incidental match once', query, sort)
) from search_pagination;
select is(jsonb_build_array(payload->'hasMore', second_payload->'hasMore', third_payload->'hasMore'), '[true,true,false]'::jsonb,
  format('%s/%s pagination reports the correct continuation state', query, sort))
from search_pagination;
select is(second_payload->'scopeFacets', payload->'scopeFacets', format('%s/%s pagination keeps full scope counts', query, sort))
from search_pagination;
select is(third_payload->'stageFacets', payload->'stageFacets', format('%s/%s pagination keeps full stage counts', query, sort))
from search_pagination;

create temp table filtered_search as
select query, scope, stage,
  public.get_session_list_page('session-search-fixture', session_scope => scope,
    stage_filter_slug => stage, search_query => query, sort_key => 'number') payload
from (values ('42'), ('#42')) queries(query)
cross join (values ('all'), ('active'), ('archived')) scopes(scope)
cross join (values (null::text), ('plan'), ('build')) stages(stage);

select is(
  (select coalesce(jsonb_agg(row->'number'), '[]'::jsonb) from jsonb_array_elements(payload->'sessions') row),
  case
    when stage = 'plan' and scope = 'archived' then '[]'::jsonb
    when stage = 'plan' then '[42]'::jsonb
    when stage = 'build' and scope = 'active' then '[6]'::jsonb
    when stage = 'build' and scope = 'archived' then '[142]'::jsonb
    when stage = 'build' then '[142,6]'::jsonb
    when scope = 'active' then '[42,6]'::jsonb
    when scope = 'archived' then '[142]'::jsonb
    else '[42,142,6]'::jsonb
  end,
  format('%s/%s/%s applies scope and stage to the same search matches', query, scope, coalesce(stage, 'all'))
) from filtered_search;
select is(payload->'scopeFacets',
  case stage
    when 'plan' then '{"active":1,"archived":0,"all":1}'::jsonb
    when 'build' then '{"active":1,"archived":1,"all":2}'::jsonb
    else '{"active":2,"archived":1,"all":3}'::jsonb
  end,
  format('%s/%s/%s scope counts honor stage and ignore scope', query, scope, coalesce(stage, 'all'))
) from filtered_search;
select is(payload->'stageFacets',
  case scope
    when 'active' then '[{"count":1,"name":"Plan","position":1,"slug":"plan"},{"count":1,"name":"Build","position":2,"slug":"build"}]'::jsonb
    when 'archived' then '[{"count":1,"name":"Build","position":2,"slug":"build"}]'::jsonb
    else '[{"count":1,"name":"Plan","position":1,"slug":"plan"},{"count":2,"name":"Build","position":2,"slug":"build"}]'::jsonb
  end,
  format('%s/%s/%s stage counts honor scope and ignore stage', query, scope, coalesce(stage, 'all'))
) from filtered_search;

select is(
  (select jsonb_agg(row->'number') from jsonb_array_elements(
    public.get_session_list_page('session-search-fixture', search_query => 'comments', sort_key => 'number')->'sessions'
  ) row),
  '[142,42,6]'::jsonb, 'ordinary text search retains the requested number sort');
select is(jsonb_array_length(public.get_session_list_page('session-search-fixture', search_query => 'comments')->'sessions'),
  3, 'ordinary text search retains all matching local sessions');
select is(public.get_session_list_page('session-search-fixture', search_query => 'prompt-only-marker')->'sessions'->0->>'number',
  '10', 'prompt-only search still works');
select is(public.get_session_list_page('session-search-fixture', search_query => 'ordinary title')->'sessions'->0->>'number',
  '10', 'title search still works');
select is(public.get_session_list_page('session-search-fixture', search_query => 'op-517')->'sessions'->0->>'number',
  '42', 'case-insensitive Linear identifier search still works');

select lives_ok(format($query$select public.get_session_list_page('session-search-fixture', search_query => %L)$query$, query),
  format('invalid or out-of-range identifier %s never throws', query))
from (values ('#'), ('##42'), ('-42'), ('4.2'), ('#42x'), ('2147483648'), ('#9999999999999999999999999999999999999999999999')) invalid(query);
select is(public.get_session_list_page('session-search-fixture', search_query => '#999')->'sessions',
  '[]'::jsonb, 'a nonexistent identifier has an empty result');
select is(public.get_session_list_page('session-search-fixture', search_query => '#999')->'scopeFacets',
  '{"active":0,"archived":0,"all":0}'::jsonb, 'a nonexistent identifier has zero scope counts');
select is(public.get_session_list_page('session-search-fixture', search_query => '#999')->'stageFacets',
  '[]'::jsonb, 'a nonexistent identifier has no stage facets');

select is(public.get_session_list_page('session-search-other', search_query => '#42')->'sessions'->0->>'id',
  '51700000-0003-4000-8000-000000000142', 'the same identifier resolves within the selected workspace');
select is(jsonb_array_length(public.get_session_list_page('session-search-other', search_query => '42')->'sessions'),
  1, 'an accessible second workspace never includes the first workspace results');
select ok(public.get_session_list_page('session-search-private', search_query => '#42') is null,
  'knowing a session number does not expose a workspace without membership');

select * from finish();
rollback;
