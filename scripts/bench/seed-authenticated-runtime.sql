begin;
set local statement_timeout = '90s';
set local lock_timeout = '2s';

create temp table fixture_scope on commit drop as
select w.id as workspace_id, w.created_at + interval '14 days' as seed_time,
       m.id as member_id, f.id as factory_id, p.id as pipeline_id,
       a.id as agent_id, pr.id as agent_prompt_revision_id,
       o.selected_github_repository_id as repository_id
from public.workspaces w
join public.workspace_members m on m.workspace_id = w.id and m.role = 'owner'
join public.factories f on f.workspace_id = w.id and f.is_default
join public.pipelines p on p.factory_id = f.id and p.is_default
join public.factory_agents a on a.factory_id = f.id and a.is_default
join public.factory_agent_prompt_revisions pr on pr.agent_id = a.id and pr.revision_number = 1
join public.workspace_onboarding o on o.workspace_id = w.id and o.status = 'completed'
where w.id = 'b1b2c3d4-0001-4000-8000-000000000001' and w.slug = 'acme-corp'
  and m.user_id = 'a1b2c3d4-0001-4000-8000-000000000001'
  and m.email = 'anant@example.com' and m.kind = 'human' and m.is_active
  and f.id = 'e1b2c3d4-0001-4000-8000-000000000001';

create temp table fixture_size on commit drop as select :fixture_size::int as n;

do $guard$
declare
  target_size int := (select n from fixture_size);
  existing_size int := case target_size when 160 then 0 when 3200 then 160 end;
begin
  if existing_size is null
    or (select count(*) from fixture_scope) <> 1
    or (select count(*) from public.workspaces) <> 1
    or (select count(*) from public.sessions) <> 18 + existing_size
    or (select count(*) from public.sessions where number between 1 and 18) <> 18
    or (select count(*) from public.pipeline_stages
        where pipeline_id = (select pipeline_id from fixture_scope) and archived_at is null) <> 4
    or exists (select 1 from public.agent_jobs)
    or (select count(*) from public.sessions
        where number between 1001 and 1000 + existing_size
          and id = ('fa1e1000-0000-4000-8000-' || lpad((number - 1000)::text, 12, '0'))::uuid
          and starts_with(title, '[wall-audit] ')) <> existing_size
  then raise exception 'Expected an isolated, freshly seeded local performance fixture';
  end if;
end;
$guard$;

create temp table fixture_new on commit drop as
select n, ('fa1e1000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as id,
       ('fa1e2000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as artifact_id,
       seed_time - make_interval(mins => n) as at_time,
       ps.id as stage_id, ps.slug as stage_slug, ps.name as stage_name, scope.*
from generate_series(
  case (select n from fixture_size) when 160 then 1 else 161 end,
  (select n from fixture_size)
) as series(n)
cross join fixture_scope scope
join public.pipeline_stages ps on ps.pipeline_id = scope.pipeline_id and ps.archived_at is null
  and ps.position = case when n <= 2 then 1 else 1 + ((n - 1) % 4) end;

set local session_replication_role = replica;

insert into public.sessions (
  id, workspace_id, factory_id, number, title, prompt_md, creator_member_id, pipeline_id,
  current_stage_id, phase_status, current_artifact_id, current_artifact_version, github_repository_id,
  created_at, updated_at, archived_at
)
select id, workspace_id, factory_id, 1000 + n,
  case n when 1 then '[wall-audit] Checkout latency short' when 2 then '[wall-audit] Checkout latency long'
    else format('[wall-audit] Session %s', n) end,
  'Synthetic checkout review fixture. No external systems or customer data.',
  member_id, pipeline_id, stage_id,
  case when n <= 2 then 'awaiting_review'::public.pipeline_phase_status else
    (array['awaiting_review','in_progress','approved','rejected']::public.pipeline_phase_status[])[1 + ((n - 1) / 4 % 4)] end,
  artifact_id, 1, repository_id, at_time - interval '5 minutes', at_time,
  case when n % 10 = 0 then at_time + interval '1 minute' end
from fixture_new;

insert into public.session_selected_stages (session_id, workspace_id, stage_id)
select item.id, item.workspace_id, ps.id from fixture_new item
join public.pipeline_stages ps on ps.pipeline_id = item.pipeline_id and ps.archived_at is null;

insert into public.session_artifacts (
  id, session_id, workspace_id, stage_id, stage_slug, version, artifact_json, created_at
)
select artifact_id, id, workspace_id, stage_id, stage_slug, 1, to_jsonb(
  case n when 1 then
    E'# Wallie audit artifact short\n\n' || repeat(E'Checkout waits for inventory, tax, and shipping. This is a local synthetic review.\n\n', 48)
  when 2 then E'# Wallie audit artifact long\n\n' || (
    select string_agg(format(E'### Timing checkpoint %s\n\nThe local checkout fixture verified inventory, tax, and shipping. Evidence digest %s%s.\n\n',
      section, md5('inventory-' || section), md5('shipping-' || section)), '' order by section)
    from generate_series(1, 640) parts(section)
  ) else E'# Review fixture\n\nA synthetic artifact; this session will not enqueue an agent job.' end
), at_time from fixture_new;

insert into public.agent_runs (
  id, workspace_id, session_id, triggered_by_member_id, stage_id, stage_slug, stage_name,
  run_type, model_provider, model_name, status, started_at, finished_at, last_activity_at,
  created_at, updated_at, agent_id, agent_prompt_revision_id
)
select ('fa1e3000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  workspace_id, id, member_id, stage_id, stage_slug, stage_name, 'code', 'anthropic', 'claude-opus-4-8',
  case when n % 5 = 0 then 'error'::public.agent_run_status else 'success'::public.agent_run_status end,
  at_time - interval '2 minutes', at_time, at_time, at_time - interval '2 minutes', at_time,
  agent_id, agent_prompt_revision_id
from fixture_new;

commit;
analyze public.sessions, public.agent_runs, public.session_artifacts, public.session_selected_stages;
