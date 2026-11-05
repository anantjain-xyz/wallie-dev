-- Extra acme-corp sessions for the navigation benchmark.
-- Safe to rerun. Deletes prior [bench] rows, then inserts 160 sessions
-- numbered from 1001, each with the pipeline's selected stages, one artifact,
-- and one successful run. Session 1001 is "[bench] Checkout latency" and is
-- the row the benchmark opens.

begin;

-- Direct inserts from psql have no JWT. The session trigger treats that as an
-- authenticated insert and rejects it. The benchmark seed is a local operator
-- script, so it takes the same service-role path the worker uses.
select set_config('request.jwt.claim.role', 'service_role', true);

delete from public.sessions as session
using public.workspaces as workspace
where session.workspace_id = workspace.id
  and workspace.slug = 'acme-corp'
  and session.title like '[bench] %';

insert into public.sessions (
  workspace_id,
  number,
  title,
  prompt_md,
  creator_member_id,
  pipeline_id,
  current_stage_id,
  phase_status,
  current_artifact_version,
  github_repository_id,
  created_at,
  updated_at
)
select
  workspace_row.workspace_id,
  1000 + series.n,
  case
    when series.n = 1 then '[bench] Checkout latency'
    else format('[bench] Session %s', series.n)
  end,
  'Benchmark prompt. Measure navigation with a realistic session count.',
  workspace_row.member_id,
  workspace_row.pipeline_id,
  stage.id,
  (
    array['awaiting_review', 'in_progress', 'approved', 'rejected']::public.pipeline_phase_status[]
  )[1 + ((series.n - 1) % 4)],
  1,
  workspace_row.repository_id,
  now() - make_interval(mins => series.n),
  now() - make_interval(mins => series.n)
from generate_series(1, 160) as series(n)
cross join (
  select
    workspace.id as workspace_id,
    member.id as member_id,
    pipeline.id as pipeline_id,
    onboarding.selected_github_repository_id as repository_id
  from public.workspaces as workspace
  join public.workspace_members as member
    on member.workspace_id = workspace.id
   and member.kind = 'human'
   and member.is_active
  join public.pipelines as pipeline
    on pipeline.workspace_id = workspace.id
   and pipeline.is_default
  join public.workspace_onboarding as onboarding
    on onboarding.workspace_id = workspace.id
  where workspace.slug = 'acme-corp'
  limit 1
) as workspace_row
join lateral (
  select stage_row.id
  from public.pipeline_stages as stage_row
  where stage_row.pipeline_id = workspace_row.pipeline_id
    and stage_row.archived_at is null
  order by stage_row.position
  offset (
    (series.n - 1) % (
      select count(*)
      from public.pipeline_stages as counted
      where counted.pipeline_id = workspace_row.pipeline_id
        and counted.archived_at is null
    )
  )
  limit 1
) as stage on true;

-- The detail page inner-joins selected stages. A direct session insert does
-- not create those rows, so the stage timeline would render with no buttons.
insert into public.session_selected_stages (session_id, workspace_id, stage_id)
select session.id, session.workspace_id, stage.id
from public.sessions as session
join public.pipeline_stages as stage
  on stage.pipeline_id = session.pipeline_id
 and stage.workspace_id = session.workspace_id
 and stage.archived_at is null
where session.title like '[bench] %';

insert into public.session_artifacts (
  session_id,
  workspace_id,
  stage_id,
  stage_slug,
  version,
  artifact_json
)
select
  session.id,
  session.workspace_id,
  session.current_stage_id,
  stage.slug,
  1,
  to_jsonb(
    case
      when session.number = 1001 then repeat(
        E'# Checkout latency\n\nThe checkout path waits on inventory, tax, and shipping before it can show a total.\n\n',
        40
      )
      else repeat(E'# Plan\n\nBenchmark artifact for list and board payloads.\n\n', 6)
    end
  )
from public.sessions as session
join public.pipeline_stages as stage on stage.id = session.current_stage_id
where session.title like '[bench] %';

update public.sessions as session
set current_artifact_id = artifact.id
from public.session_artifacts as artifact
where artifact.session_id = session.id
  and artifact.version = 1
  and session.title like '[bench] %';

-- The artifact update fires sessions_touch_updated_at, which stamps every row
-- with the same clock time. Disable that trigger for the timestamp restore so
-- session 1001 stays the newest row on the default list.
alter table public.sessions disable trigger sessions_touch_updated_at;

update public.sessions
set updated_at = now() - make_interval(mins => number - 1000)
where title like '[bench] %';

alter table public.sessions enable trigger sessions_touch_updated_at;

insert into public.agent_runs (
  workspace_id,
  session_id,
  triggered_by_member_id,
  stage_id,
  stage_slug,
  stage_name,
  run_type,
  model_provider,
  model_name,
  status,
  last_activity_at,
  started_at,
  finished_at
)
select
  session.workspace_id,
  session.id,
  session.creator_member_id,
  session.current_stage_id,
  stage.slug,
  stage.name,
  'code',
  'anthropic',
  'claude-opus-4-8',
  'success',
  session.updated_at,
  session.updated_at - interval '5 minutes',
  session.updated_at
from public.sessions as session
join public.pipeline_stages as stage on stage.id = session.current_stage_id
where session.title like '[bench] %';

commit;
