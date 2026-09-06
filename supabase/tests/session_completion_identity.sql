begin;
create extension if not exists pgtap with schema extensions;
select plan(6);

-- Use the seeded member/session, without retaining fixture changes after the test.
select set_config('request.jwt.claim.sub', (select id::text from auth.users where email = 'anant@example.com'), true);
insert into public.session_selected_stages (session_id, workspace_id, stage_id)
select s.id, s.workspace_id, stage.id from public.sessions s
join public.workspaces w on w.id = s.workspace_id
join public.pipeline_stages stage on stage.pipeline_id = s.pipeline_id
where w.slug = 'acme-corp' and s.number = 2 and stage.archived_at is null
on conflict do nothing;

create temp table expected_completion as
select completion.* from public.session_phase_completions completion
join public.sessions s on s.id = completion.session_id
join public.workspaces w on w.id = s.workspace_id
where w.slug = 'acme-corp' and s.number = 2 and completion.stage_slug = 'plan';

select is(public.get_session_detail_page('acme-corp', 2) #>> '{session,phaseCompletions,0,stageId}',
  (select stage_id::text from expected_completion), 'detail RPC carries durable stage identity');
select is(public.get_session_detail_page('acme-corp', 2) #>> '{session,phaseCompletions,0,id}',
  (select id::text from expected_completion), 'detail RPC carries completion identity for realtime deletion');

update public.pipeline_stages set slug = 'discovery-renamed' where id = (select stage_id from expected_completion);
select is(public.get_session_detail_page('acme-corp', 2) #>> '{session,phaseCompletions,0,stageId}',
  (select stage_id::text from expected_completion), 'completion retains its identity after the stage slug changes');
select is(public.get_session_detail_page('acme-corp', 2) #>> '{session,phaseCompletions,0,stageSlug}',
  'plan', 'historical completion slug remains a snapshot');
select ok(exists(select 1 from jsonb_array_elements(public.get_session_detail_page('acme-corp', 2) #> '{session,pipeline,stages}') stage
  where stage->>'id' = (select stage_id::text from expected_completion) and stage->>'slug' = 'discovery-renamed'),
  'live stage and historical completion can be joined by ID');

select set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
select ok(not (public.get_session_detail_page('acme-corp', 2) ? 'session'), 'a nonmember still cannot read the session');
select * from finish();
rollback;
