begin;

create extension if not exists pgtap with schema extensions;

select plan(6);
set local "request.jwt.claim.role" = 'service_role';

select has_function(
  'public',
  'publish_session_stage_artifact',
  array['uuid', 'uuid', 'uuid', 'text', 'integer', 'integer', 'text'],
  'publish RPC exists'
);

create temp table test_baseline as
select last_issue_number
from internal.workspace_issue_counters
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

create temp table publish_session as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Publish canonical markdown',
  'Stay in_progress until the RPC.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

insert into public.session_artifacts (
  workspace_id,
  session_id,
  stage_id,
  stage_slug,
  version,
  artifact_json
)
select
  'b1b2c3d4-0001-4000-8000-000000000001',
  result.session_id,
  session.current_stage_id,
  stage.slug,
  1,
  to_jsonb('stale recovered markdown'::text)
from publish_session result
join public.sessions session on session.id = result.session_id
join public.pipeline_stages stage on stage.id = session.current_stage_id;

select ok(
  public.publish_session_stage_artifact(
    (select session_id from publish_session),
    'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = (select session_id from publish_session)),
    (select stage.slug
     from publish_session result
     join public.sessions session on session.id = result.session_id
     join public.pipeline_stages stage on stage.id = session.current_stage_id),
    0,
    1,
    'canonical retry markdown'
  ),
  'in_progress session publishes'
);

select is(
  (select phase_status::text from public.sessions where id = (select session_id from publish_session)),
  'awaiting_review',
  'pointer advances only with the canonical write'
);
select is(
  (
    select artifact.artifact_json
    from public.session_artifacts artifact
    where artifact.session_id = (select session_id from publish_session)
      and artifact.version = 1
  ),
  to_jsonb('canonical retry markdown'::text),
  'reviewers see the retry markdown, not the recovered stale row'
);
select ok(
  not public.publish_session_stage_artifact(
    (select session_id from publish_session),
    'b1b2c3d4-0001-4000-8000-000000000001',
    (select current_stage_id from public.sessions where id = (select session_id from publish_session)),
    (select stage.slug
     from publish_session result
     join public.sessions session on session.id = result.session_id
     join public.pipeline_stages stage on stage.id = session.current_stage_id),
    0,
    1,
    'loser markdown'
  ),
  'a second generation cannot republish'
);
select is(
  (
    select artifact.artifact_json
    from public.session_artifacts artifact
    where artifact.session_id = (select session_id from publish_session)
      and artifact.version = 1
  ),
  to_jsonb('canonical retry markdown'::text),
  'losing generation does not overwrite published markdown'
);

delete from public.sessions
where id in (select session_id from publish_session);

update internal.workspace_issue_counters
set last_issue_number = (select last_issue_number from test_baseline),
    updated_at = now()
where workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

select * from finish();

commit;
