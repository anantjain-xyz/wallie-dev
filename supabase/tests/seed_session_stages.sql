begin;
create extension if not exists pgtap with schema extensions;
select plan(4);

-- Exercise the actual fresh seed, without repairing its relationships in the test.
create temp table demo_sessions as
select s.* from public.sessions s
join public.workspaces w on w.id = s.workspace_id
where w.slug = 'acme-corp' and s.number between 1 and 18;

select is((select count(*) from demo_sessions), 18::bigint,
  'the complete 18-session demo fixture is present');

select is((select count(*) from public.session_selected_stages selection
  join demo_sessions s on s.id = selection.session_id
  join public.pipeline_stages stage on stage.id = selection.stage_id
  where selection.workspace_id = s.workspace_id
    and stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id),
  72::bigint, 'demo selections belong to the correct workspace and pipeline');

select is((select count(*) from demo_sessions s
  where not exists (select 1 from public.session_selected_stages selection
    where selection.session_id = s.id and selection.stage_id = s.current_stage_id)),
  0::bigint, 'every demo session includes its current stage in its selection');

select set_config('request.jwt.claim.sub',
  (select id::text from auth.users where email = 'anant@example.com'), true);
select is((select count(*) from demo_sessions s
  where jsonb_array_length(public.get_session_detail_page('acme-corp', s.number)
    #> '{session,pipeline,stages}') = 4),
  18::bigint, 'the authenticated detail endpoint exposes all four stages for every demo session');

select * from finish();
rollback;
