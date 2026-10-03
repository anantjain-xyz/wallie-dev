-- Apply with the matching worker after stopping/draining old reconcilers.
-- Source state spans identify transitions; retained artifacts remain immutable.
set check_function_bodies = off;

create table "internal"."session_linear_transition_receipts" (
    "session_id" uuid not null,
    "baseline_at" timestamp with time zone not null,
    "source_span_id" text,
    "source_started_at" timestamp with time zone,
    "source_state_id" text,
    "issue_updated_at" timestamp with time zone,
    "routing_config" jsonb,
    "observed_at" timestamp with time zone not null default now()
      );


alter table "internal"."session_linear_transition_receipts" enable row level security;

CREATE UNIQUE INDEX session_linear_transition_receipts_pkey ON internal.session_linear_transition_receipts USING btree (session_id);

alter table "internal"."session_linear_transition_receipts" add constraint "session_linear_transition_receipts_pkey" PRIMARY KEY using index "session_linear_transition_receipts_pkey";

alter table "internal"."session_linear_transition_receipts" add constraint "session_linear_transition_receipts_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.sessions(id) ON DELETE CASCADE not valid;

alter table "internal"."session_linear_transition_receipts" validate constraint "session_linear_transition_receipts_session_id_fkey";

CREATE OR REPLACE FUNCTION internal.preserve_session_artifact_version_history()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare target_slug text;
begin
  if new.current_stage_id is distinct from old.current_stage_id then
    select slug into target_slug from public.pipeline_stages
    where id = new.current_stage_id and workspace_id = new.workspace_id and pipeline_id = new.pipeline_id;
    if not found then raise exception 'Session stage is outside its workspace pipeline' using errcode = '23514'; end if;
    new.current_artifact_version := greatest(new.current_artifact_version, coalesce((
      select max(version) from public.session_artifacts
      where session_id = new.id and stage_slug = target_slug
    ), 0));
  end if;
  return new;
end;
$function$
;

CREATE OR REPLACE FUNCTION internal.seed_session_linear_transition_receipt()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if new.linear_issue_id is not null then
    insert into internal.session_linear_transition_receipts(session_id, baseline_at)
    values (new.id, new.created_at) on conflict do nothing;
  end if;
  return new;
end;
$function$
;

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
  normalized_name text := lower(regexp_replace(btrim(p_status_name), '\s+', ' ', 'g'));
  canceled_jobs uuid[] := '{}';
  canceled_runs uuid[] := '{}';
  queued_job uuid;
  queued_run uuid;
  result text := 'observed';
  initial_baseline boolean;
begin
  if nullif(btrim(p_source_span_id), '') is null or nullif(btrim(p_source_state_id), '') is null
     or nullif(normalized_name, '') is null or p_source_started_at is null or p_source_issue_updated_at is null
     or p_source_started_at > p_source_issue_updated_at then
    raise exception 'A coherent Linear state span is required' using errcode = '22023';
  end if;
  select session.pipeline_id into pipeline_id from public.sessions session
  where session.id = p_session_id and session.workspace_id = p_workspace_id;
  if not found then return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return; end if;
  -- Pipeline rewrites lock this row before stages/config. Match that order.
  perform 1 from public.pipelines pipeline
  where pipeline.id = pipeline_id and pipeline.workspace_id = p_workspace_id for share;
  select * into config from public.workspace_linear_routing where workspace_id = p_workspace_id for share;
  if not found then raise exception 'Linear routing configuration is missing' using errcode = '55000'; end if;
  if config.updated_at is distinct from p_expected_routing_updated_at then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  -- A corrupt configuration is never interpreted as a destructive default.
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
  config_key := jsonb_build_object('route', route_key, 'target', case
    when route_key = 'rework' then config.rework_stage_slug
    when route_key in ('merging','done') then config.land_stage_slug else null end);
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
  if receipt.source_span_id = p_source_span_id and receipt.routing_config = config_key then
    update internal.session_linear_transition_receipts set issue_updated_at = p_source_issue_updated_at,
      observed_at = now() where session_id = s.id;
    return query select 'duplicate', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  initial_baseline := receipt.source_span_id is null and p_source_started_at <= receipt.baseline_at;
  if route_key = 'rework' then target_slug := config.rework_stage_slug;
  elsif route_key in ('merging','done') then target_slug := config.land_stage_slug; end if;
  if target_slug is not null then
    select stage.* into target from public.pipeline_stages stage
    join public.session_selected_stages selected on selected.stage_id = stage.id and selected.session_id = s.id
    where stage.workspace_id = s.workspace_id and stage.pipeline_id = s.pipeline_id
      and stage.slug = target_slug for share of stage;
    if not found and route_key <> 'done' then
      return query select 'missing_stage', canceled_jobs, canceled_runs, queued_job, queued_run; return;
    end if;
  end if;
  if s.archived_at is not null and target.id is not null then
    return query select 'stale', canceled_jobs, canceled_runs, queued_job, queued_run; return;
  end if;
  if route_key = 'canceled' or (route_key = 'done' and target.id is null) then
    select archived.job_ids, archived.run_ids into canceled_jobs, canceled_runs
    from public.archive_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', route_key = 'done') archived;
    result := case when route_key = 'done' then 'completed' else 'archived' end;
  elsif not initial_baseline and target.id is not null then
    select canceled.job_ids, canceled.run_ids into canceled_jobs, canceled_runs
    from public.cancel_session_job_attempts(s.id, s.workspace_id,
      'Linear issue moved to "' || p_status_name || '".', null, false) canceled;
    delete from public.session_artifact_feedback feedback using public.pipeline_stages stage
    where feedback.session_id = s.id and feedback.stage_id = stage.id
      and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
    delete from public.session_phase_completions completion using public.pipeline_stages stage
    where completion.session_id = s.id and completion.stage_id = stage.id
      and stage.pipeline_id = s.pipeline_id and stage.position >= target.position;
    update public.sessions set current_stage_id = target.id,
      current_artifact_version = coalesce((select max(version) from public.session_artifacts
        where session_id = s.id and stage_slug = target.slug), 0),
      phase_status = 'rejected', rejection_count = 0 where id = s.id;
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,target.id,null,'assignment',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    if queued_run is null then raise exception 'Linear replacement needs an atomic queued run' using errcode = '55000'; end if;
    result := 'routed';
  elsif not initial_baseline and route_key in ('todo','in_progress')
      and s.phase_status in ('in_progress','rejected') then
    select queued.job_id, queued.run_id into queued_job, queued_run
    from public.enqueue_session_job_with_run(s.id,s.workspace_id,s.current_stage_id,null,'assignment',
      p_agent_model_provider,p_agent_model_name,p_run_type) queued;
    result := 'queued';
  end if;
  update internal.session_linear_transition_receipts set source_span_id = p_source_span_id,
    source_started_at = p_source_started_at, source_state_id = p_source_state_id,
    issue_updated_at = p_source_issue_updated_at, routing_config = config_key, observed_at = now()
  where session_id = s.id;
  return query select result, canceled_jobs, canceled_runs, queued_job, queued_run;
end;
$function$
;

-- Schema diff can order triggers before their functions and omit UPDATE OF
-- triggers. Install both after their dependencies exist.
create trigger sessions_seed_linear_transition_receipt after insert on public.sessions
for each row execute function internal.seed_session_linear_transition_receipt();
create trigger sessions_preserve_artifact_version_history before update of current_stage_id on public.sessions
for each row execute function internal.preserve_session_artifact_version_history();

-- Adopt existing work without replaying an old stage intent on rollout.
-- Terminal dispositions are still applied on the first observation.
insert into internal.session_linear_transition_receipts(session_id,baseline_at)
select id,statement_timestamp() from public.sessions where linear_issue_id is not null;

revoke all on internal.session_linear_transition_receipts from public,anon,authenticated;
grant select,insert,update,delete on internal.session_linear_transition_receipts to service_role;
grant usage on schema internal to service_role;
revoke all on function internal.seed_session_linear_transition_receipt() from public,anon,authenticated;
revoke all on function internal.preserve_session_artifact_version_history() from public,anon,authenticated;
revoke all on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text) from public,anon,authenticated;
grant execute on function public.apply_linear_session_transition(uuid,uuid,text,timestamptz,timestamptz,text,timestamptz,text,timestamptz,text,text,text,text) to service_role;
