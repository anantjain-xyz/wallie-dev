-- Keep the stage the manager selected when labels change across revisions.
alter table public.workspace_linear_routing
  add column rework_stage_id uuid,
  add column land_stage_id uuid;

-- Route writes must derive IDs under the publication lock in the guarded RPC.
revoke insert, update, delete on public.workspace_linear_routing from authenticated;

create function public.save_linear_routing_config(
  p_workspace_id uuid, p_actor_user_id uuid, p_rework_slug text, p_status_mappings jsonb,
  p_land_slug text default null, p_check_revision boolean default false,
  p_expected_revision_id uuid default null
) returns public.workspace_linear_routing
language plpgsql security definer set search_path = '' as $$
declare
  revision_id uuid;
  definition jsonb;
  rework_id uuid;
  land_id uuid;
  result public.workspace_linear_routing;
begin
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.pipelines p
  where p.workspace_id=p_workspace_id and p.is_default for share;
  perform m.id from public.workspace_members m
  where m.workspace_id=p_workspace_id and m.user_id=p_actor_user_id
    and m.kind='human' and m.is_active and m.role in ('owner','admin') for share;
  if not found then
    raise exception 'Active workspace manager access is required.' using errcode='42501';
  end if;

  select a.revision_id, r.definition_json::jsonb into revision_id, definition
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id,a.factory_id)=(f.workspace_id,f.id)
  join public.factory_definition_revisions r on (r.workspace_id,r.factory_id,r.id)=(a.workspace_id,a.factory_id,a.revision_id)
  where f.workspace_id=p_workspace_id and f.is_default
  order by a.activation_number desc limit 1;
  if p_check_revision and p_expected_revision_id is distinct from revision_id then
    raise exception 'The published pipeline changed. Reload the routing options before saving.' using errcode='PT409';
  end if;

  if revision_id is not null then
    select (stage->>'id')::uuid into rework_id from jsonb_array_elements(definition->'stages') stage
      where stage->>'slug'=p_rework_slug;
    select (stage->>'id')::uuid into land_id from jsonb_array_elements(definition->'stages') stage
      where stage->>'slug'=p_land_slug;
    if rework_id is null or (p_land_slug is not null and land_id is null) then
      raise exception 'Route targets must be part of the published pipeline.' using errcode='PT422';
    end if;
  elsif exists (
    select 1 from unnest(array[p_rework_slug,p_land_slug]) required(slug)
    where required.slug is not null and not exists (
      select 1 from public.pipeline_stages stage
      join public.pipelines pipeline on (pipeline.workspace_id,pipeline.id)=(stage.workspace_id,stage.pipeline_id)
      where pipeline.workspace_id=p_workspace_id and pipeline.is_default
        and stage.slug=required.slug and stage.archived_at is null
    )
  ) then
    raise exception 'Route targets must be active stages in the default pipeline.' using errcode='PT422';
  end if;

  insert into public.workspace_linear_routing (workspace_id,status_mappings,rework_stage_slug,land_stage_slug,rework_stage_id,land_stage_id)
  values (p_workspace_id,p_status_mappings,p_rework_slug,p_land_slug,rework_id,land_id)
  on conflict (workspace_id) do update set status_mappings=excluded.status_mappings,
    rework_stage_slug=excluded.rework_stage_slug,land_stage_slug=excluded.land_stage_slug,
    rework_stage_id=excluded.rework_stage_id,land_stage_id=excluded.land_stage_id
  returning * into result;
  return result;
end;
$$;
revoke all on function public.save_linear_routing_config(uuid,uuid,text,jsonb,text,boolean,uuid)
  from public, anon, authenticated;
grant execute on function public.save_linear_routing_config(uuid,uuid,text,jsonb,text,boolean,uuid)
  to service_role;

create function internal.resolve_linear_session_stage(p_session public.sessions, p_slug text)
returns public.pipeline_stages language plpgsql set search_path = '' as $$
declare
  live_id uuid;
  target public.pipeline_stages;
begin
  if p_session.execute_pinned_definition then
    -- A live label takes precedence over a matching historical label.
    select stage.id into live_id from public.pipeline_stages stage
    where (stage.workspace_id,stage.pipeline_id,stage.slug) =
      (p_session.workspace_id,p_session.pipeline_id,p_slug) for share;
    select stage.* into target from internal.session_execution_stages(p_session) stage
    join public.session_selected_stages selected on selected.stage_id=stage.id and selected.session_id=p_session.id
    where case when live_id is not null then stage.id=live_id else stage.slug=p_slug end;
  else
    select stage.* into target from public.pipeline_stages stage
    join public.session_selected_stages selected on selected.stage_id=stage.id and selected.session_id=p_session.id
    where (stage.workspace_id,stage.pipeline_id,stage.slug) =
      (p_session.workspace_id,p_session.pipeline_id,p_slug) for share of stage;
  end if;
  return target;
end;
$$;
revoke all on function internal.resolve_linear_session_stage(public.sessions,text)
  from public, anon, authenticated, service_role;
grant execute on function internal.resolve_linear_session_stage(public.sessions,text) to service_role;

CREATE OR REPLACE FUNCTION public.apply_linear_session_transition(p_session_id uuid, p_workspace_id uuid, p_linear_issue_id text, p_expected_session_updated_at timestamp with time zone, p_expected_routing_updated_at timestamp with time zone, p_source_span_id text, p_source_started_at timestamp with time zone, p_source_state_id text, p_source_issue_updated_at timestamp with time zone, p_status_name text, p_agent_model_provider text DEFAULT NULL::text, p_agent_model_name text DEFAULT NULL::text, p_run_type text DEFAULT 'project'::text)
 RETURNS TABLE(outcome text, job_ids uuid[], run_ids uuid[], job_id uuid, run_id uuid)
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  s public.sessions%rowtype;
  config public.workspace_linear_routing%rowtype;
  receipt internal.session_linear_transition_receipts%rowtype;
  target public.pipeline_stages%rowtype;
  pipeline_id uuid;
  config_key jsonb;
  route_key text;
  candidate text;
  target_slug text;
  target_id uuid;
  prior_target_id uuid;
  normalized_name text := lower(regexp_replace(btrim(p_status_name), '\s+', ' ', 'g'));
  canceled_jobs uuid[] := '{}';
  canceled_runs uuid[] := '{}';
  queued_job uuid;
  queued_run uuid;
  result text := 'observed';
  initial_baseline boolean;
  code text;
  policy public.execution_policy_revisions;
  max_repairs integer;
begin
  if nullif(btrim(p_source_span_id), '') is null or nullif(btrim(p_source_state_id), '') is null
     or nullif(normalized_name, '') is null or p_source_started_at is null or p_source_issue_updated_at is null
     or p_source_started_at > p_source_issue_updated_at then
    raise exception 'A coherent Linear state span is required' using errcode = '22023';
  end if;
  select session.pipeline_id into pipeline_id from public.sessions session
  where session.id = p_session_id and session.workspace_id = p_workspace_id;
  if not found then return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return; end if;
  perform internal.assert_workspace_accepts_work(p_workspace_id);
  perform 1 from public.pipelines pipeline where pipeline.id = pipeline_id and pipeline.workspace_id = p_workspace_id for share;
  select * into config from public.workspace_linear_routing where workspace_id = p_workspace_id for share;
  if not found then raise exception 'Linear routing configuration is missing' using errcode = '55000'; end if;
  if config.updated_at is distinct from p_expected_routing_updated_at then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  foreach candidate in array array['backlog','todo','in_progress','in_review','rework','merging','done','canceled'] loop
    if jsonb_typeof(config.status_mappings -> candidate) is distinct from 'array'
       or jsonb_array_length(config.status_mappings -> candidate) = 0 then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if exists (select 1 from jsonb_array_elements(config.status_mappings -> candidate) value
      where jsonb_typeof(value) <> 'string' or btrim(value #>> '{}') = '') then
      raise exception 'Linear routing configuration is invalid' using errcode = '22023';
    end if;
    if route_key is null and exists (
      select 1 from jsonb_array_elements_text(config.status_mappings -> candidate) name
      where lower(regexp_replace(btrim(name), '\s+', ' ', 'g')) = normalized_name
    ) then route_key := candidate; end if;
  end loop;
  if route_key = 'rework' then
    target_slug := config.rework_stage_slug;
    target_id := config.rework_stage_id;
  elsif route_key in ('merging','done') then
    target_slug := config.land_stage_slug;
    target_id := config.land_stage_id;
  end if;
  config_key := jsonb_build_object('route', route_key, 'target', case
    when target_id is not null then jsonb_build_object('stageId', target_id)
    else to_jsonb(target_slug) end);
  select * into s from public.sessions
  where id = p_session_id and workspace_id = p_workspace_id for no key update;
  if s.pipeline_id is distinct from pipeline_id or s.linear_issue_id is distinct from p_linear_issue_id
     or ((s.updated_at is distinct from p_expected_session_updated_at or s.archived_at is not null)
         and not (s.archived_at is not null and route_key = 'done')) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  insert into internal.session_linear_transition_receipts(session_id, baseline_at)
  values(s.id, s.created_at) on conflict do nothing;
  select * into receipt from internal.session_linear_transition_receipts where session_id = s.id;
  if receipt.source_started_at is not null and (
      p_source_started_at < receipt.source_started_at
      or p_source_issue_updated_at < receipt.issue_updated_at
      or (p_source_started_at = receipt.source_started_at and p_source_span_id <> receipt.source_span_id
          and p_source_issue_updated_at <= receipt.issue_updated_at)
    ) then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if receipt.source_span_id = p_source_span_id and (receipt.source_state_id is distinct from p_source_state_id
      or receipt.source_started_at is distinct from p_source_started_at) then
    raise exception 'Linear state span identity changed' using errcode = '22023';
  end if;
  if receipt.source_span_id = p_source_span_id then
    if target_id is not null and receipt.routing_config->>'route' = route_key
      and jsonb_typeof(receipt.routing_config->'target') = 'string' then
      -- Recording a stable ID for the same stage must not re-arm the span.
      prior_target_id := (internal.resolve_linear_session_stage(s, receipt.routing_config->>'target')).id;
    end if;
    if receipt.routing_config = config_key or prior_target_id = target_id then
      update internal.session_linear_transition_receipts set issue_updated_at = p_source_issue_updated_at,
        routing_config = config_key, observed_at = now() where session_id = s.id;
      return query select 'duplicate', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  initial_baseline := receipt.source_span_id is null and p_source_started_at <= receipt.baseline_at;
  if target_id is not null or target_slug is not null then
    if target_id is not null then
      select stage.* into target from internal.session_execution_stages(s) stage
      join public.session_selected_stages selected on selected.stage_id=stage.id and selected.session_id=s.id
      where stage.id=target_id;
    else
      target := internal.resolve_linear_session_stage(s, target_slug);
    end if;
    if target.id is null and (route_key <> 'done' or s.execute_pinned_definition or target_id is not null) then
      return query select 'missing_stage', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  if s.archived_at is not null and target.id is not null then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  -- Refuse exhausted work before canceling jobs or deleting review history.
  if not initial_baseline and (target.id is not null or (route_key in('todo','in_progress') and s.phase_status in('in_progress','rejected'))) then
    code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
    if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
      select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
      max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
      if s.execution_repair_attempts>=max_repairs then
        code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
      end if;
    end if;
    if code is not null then
      update internal.session_linear_transition_receipts set source_span_id=p_source_span_id,
        source_started_at=p_source_started_at,source_state_id=p_source_state_id,
        issue_updated_at=p_source_issue_updated_at,routing_config=config_key,observed_at=now()
      where session_id=s.id;
      return query select 'exhausted',canceled_jobs,canceled_runs,queued_job,queued_run;
      return;
    end if;
  end if;
  if route_key = 'canceled' or (route_key = 'done' and target.id is null) then
    select archived.job_ids, archived.run_ids into canceled_jobs, canceled_runs
    from public.archive_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', route_key = 'done') archived;
    result := case when route_key = 'done' then 'completed' else 'archived' end;
  elsif not initial_baseline and target.id is not null then
    begin
      select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
      from public.cancel_session_job_attempts(s.id, s.workspace_id,
        'Linear issue moved to "' || p_status_name || '".', null, false) canceled;
      delete from public.session_artifact_feedback feedback using internal.session_execution_stages(s) stage
      where feedback.session_id = s.id and feedback.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      delete from public.session_phase_completions completion using internal.session_execution_stages(s) stage
      where completion.session_id = s.id and completion.stage_id = stage.id
        and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
      update public.sessions set current_stage_id = target.id, current_artifact_id = null,
        current_artifact_version = coalesce((select max(version) from public.session_artifacts
          where session_id = s.id and stage_id = target.id), 0),
        phase_status = 'rejected', rejection_count = 0 where id = s.id;
      select queued.job_id, queued.run_id into queued_job, queued_run
      from public.enqueue_session_job_with_run(s.id,s.workspace_id,target.id,null,
        case when route_key='rework' then 'manual_retry'::public.agent_trigger_type else 'assignment'::public.agent_trigger_type end,
        p_agent_model_provider,p_agent_model_name,p_run_type) queued;
      if queued_job is null then raise exception 'Linear execution budget admission refused' using errcode='P429B'; end if;
      if queued_run is null then raise exception 'Linear replacement needs an atomic queued run' using errcode = '55000'; end if;
      result := 'routed';
    exception when sqlstate 'P429B' then
      -- The inner subtransaction restores the original stage, feedback,
      -- completions and active work. Recompute and persist the reason outside it.
      canceled_jobs:='{}'; canceled_runs:='{}'; queued_job:=null; queued_run:=null;
      code:=internal.refresh_session_execution_exhaustion(s.id,s.workspace_id);
      if code is null and route_key='rework' and s.execution_policy_revision_id is not null then
        select * into policy from public.execution_policy_revisions where id=s.execution_policy_revision_id;
        max_repairs:=(policy.requirements->>'maxRepairAttempts')::integer;
        if s.execution_repair_attempts>=max_repairs then
          code:=internal.exhaust_session_execution(s.id,'repair_attempts',s.execution_repair_attempts+1,max_repairs);
        end if;
      end if;
      if code is null then raise; end if;
      result := 'exhausted';
    end;
  elsif not initial_baseline and route_key in ('todo','in_progress')
      and s.phase_status in ('in_progress','rejected') then
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,s.current_stage_id,null,'manual_retry',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    result := case when queued_job is null then 'exhausted' else 'queued' end;
  end if;
  update internal.session_linear_transition_receipts set source_span_id = p_source_span_id,
    source_started_at = p_source_started_at, source_state_id = p_source_state_id,
    issue_updated_at = p_source_issue_updated_at, routing_config = config_key, observed_at = now()
  where session_id = s.id;
  return query select result, canceled_jobs, canceled_runs, queued_job, queued_run;
end;
$function$;
