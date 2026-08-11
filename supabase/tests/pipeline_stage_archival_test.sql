begin;

create extension if not exists pgtap with schema extensions;
select plan(17);
set local "request.jwt.claim.role" = 'service_role';

-- The concurrency proof in create_session_with_first_job.sql commits through
-- dblink, so make this test independent of that file's externally committed
-- counter/session rows when the whole directory runs in one invocation.
update internal.workspace_issue_counters counter
set last_issue_number = (
  select coalesce(max(session.number), 0)
  from public.sessions session
  where session.workspace_id = counter.workspace_id
)
where counter.workspace_id = 'b1b2c3d4-0001-4000-8000-000000000001';

select has_column(
  'public', 'pipeline_stages', 'archived_at',
  'pipeline stages expose a durable archive timestamp'
);

-- Create through the production RPC before archival so this session has the
-- complete selected-stage membership that future sessions must retain.
create temp table existing_session_result as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Existing selected-stage proof',
  'Retain Review after it is archived.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

create temp table review_identity as
select id
from public.pipeline_stages
where pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
  and slug = 'review';

create temp table archive_result as
select public.rewrite_default_pipeline_with_approval_policy(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Default',
  (
    select jsonb_agg(
      jsonb_build_object(
        'id', stage.id,
        'slug', stage.slug,
        'name', stage.name,
        'description', stage.description,
        'promptTemplateMd', stage.prompt_template_md,
        'anyoneCanApprove', stage.anyone_can_approve,
        'approverMemberIds', to_jsonb(stage.approver_member_ids)
      ) order by stage.position
    )
    from public.pipeline_stages stage
    where stage.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
      and stage.slug <> 'review'
  ),
  null
) as result;

select is((select result ->> 'ok' from archive_result), 'true',
  'archiving a stage referenced by sessions succeeds');
select ok((select archived_at is not null from public.pipeline_stages where slug = 'review'),
  'the omitted stage is archived in place');
select is((select position from public.pipeline_stages where slug = 'review'), 3,
  'an archived middle stage reserves its original position');
select is(
  (select string_agg(slug, ',' order by position)
   from public.pipeline_stages
   where pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
     and archived_at is null),
  'plan,build,land',
  'active stage order skips the reserved archive slot'
);
select is(
  (select count(*)::integer
   from public.sessions session
   join public.pipeline_stages stage on stage.id = session.current_stage_id),
  (select count(*)::integer from public.sessions),
  'all session current-stage foreign keys still resolve'
);

create temp table new_session_result as
select *
from public.create_session_with_first_job(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'c1b2c3d4-0001-4000-8000-000000000001',
  'Archive-aware create proof',
  'Use only the active pipeline stages.',
  'codex',
  'gpt-5.5',
  null,
  null,
  '12b2c3d4-0001-4000-8000-000000000001',
  null
);

select is(
  (select count(*)::integer
   from public.session_selected_stages selection
   join new_session_result result on result.session_id = selection.session_id),
  3,
  'a new session selects only active stages'
);
select ok(
  not exists (
    select 1
    from public.session_selected_stages selection
    join new_session_result result on result.session_id = selection.session_id
    join public.pipeline_stages stage on stage.id = selection.stage_id
    where stage.slug = 'review'
  ),
  'a new session cannot inherit the archived stage'
);

create temp table existing_review_session as
select result.session_id as id
from existing_session_result result;

update public.sessions session
set
  current_stage_id = (select id from public.pipeline_stages where slug = 'review'),
  phase_status = 'awaiting_review',
  current_artifact_version = 1
from existing_review_session selected
where session.id = selected.id;

create temp table archived_approval_result as
select approved.*
from existing_review_session selected
cross join lateral public.approve_session_stage(
  selected.id,
  'b1b2c3d4-0001-4000-8000-000000000001',
  1,
  'c1b2c3d4-0001-4000-8000-000000000001'
) approved;

select is((select current_stage_slug from archived_approval_result), 'land',
  'an existing session can advance from an archived selected stage');
select is((select phase_status::text from archived_approval_result), 'in_progress',
  'advancing from an archived stage queues the next selected stage');

select throws_ok(
  $$
    select *
    from public.create_session_with_first_job(
      'b1b2c3d4-0001-4000-8000-000000000001',
      'c1b2c3d4-0001-4000-8000-000000000001',
      'Stale selected stage proof',
      'Reject an archived explicit selection.',
      'codex',
      'gpt-5.5',
      null,
      null,
      '12b2c3d4-0001-4000-8000-000000000001',
      null,
      array[(select id from public.pipeline_stages where slug = 'review')]
    )
  $$,
  'P0003',
  'Selected pipeline stages changed or do not belong to this pipeline',
  'a stale client cannot explicitly select an archived stage'
);

create temp table conflict_result as
select public.rewrite_default_pipeline_with_approval_policy(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Default',
  (
    select jsonb_agg(
      jsonb_build_object(
        'id', stage.id,
        'slug', stage.slug,
        'name', stage.name,
        'description', stage.description,
        'promptTemplateMd', stage.prompt_template_md,
        'anyoneCanApprove', stage.anyone_can_approve,
        'approverMemberIds', to_jsonb(stage.approver_member_ids)
      ) order by stage.position
    )
    from public.pipeline_stages stage
    where stage.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
      and stage.archived_at is null
  ) || jsonb_build_array(
    jsonb_build_object(
      'slug', 'review',
      'name', 'Review replacement',
      'description', '',
      'promptTemplateMd', 'Review it.',
      'anyoneCanApprove', true,
      'approverMemberIds', '[]'::jsonb
    )
  ),
  null
) as result;

select is((select result ->> 'error_code' from conflict_result),
  'archived_stage_slug_conflict', 'archived slugs remain reserved for restoration');
select ok((select archived_at is not null from public.pipeline_stages where slug = 'review'),
  'a slug conflict leaves the archived row unchanged');

create temp table restore_result as
select public.rewrite_default_pipeline_with_approval_policy(
  'b1b2c3d4-0001-4000-8000-000000000001',
  'Default',
  (
    select jsonb_agg(
      jsonb_build_object(
        'id', stage.id,
        'slug', stage.slug,
        'name', stage.name,
        'description', stage.description,
        'promptTemplateMd', stage.prompt_template_md,
        'anyoneCanApprove', stage.anyone_can_approve,
        'approverMemberIds', to_jsonb(stage.approver_member_ids)
      )
      order by case stage.slug
        when 'plan' then 1
        when 'review' then 2
        when 'build' then 3
        else 4
      end
    )
    from public.pipeline_stages stage
    where stage.pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
  ),
  null
) as result;

select is((select result ->> 'ok' from restore_result), 'true',
  'submitting the archived stage id restores it');
select ok((select archived_at is null from public.pipeline_stages where slug = 'review'),
  'restoration clears the archive timestamp on the original row');
select is(
  (select id from public.pipeline_stages where slug = 'review'),
  (select id from review_identity),
  'restoration preserves the durable stage id'
);
select is(
  (select string_agg(slug, ',' order by position)
   from public.pipeline_stages
   where pipeline_id = 'd1b2c3d4-0001-4000-8000-000000000001'
     and archived_at is null),
  'plan,review,build,land',
  'restoration applies the requested active order'
);

select * from finish();
rollback;
