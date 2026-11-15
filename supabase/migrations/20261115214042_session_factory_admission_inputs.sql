-- Records what admission selected alongside the immutable definition. The live
-- runner still owns its effective settings until the pinned-execution cutover.
create table public.session_factory_admission_inputs (
  session_id uuid primary key references public.sessions(id) on delete cascade,
  workspace_id uuid not null,
  factory_id uuid not null,
  activation_number bigint not null check (activation_number > 0),
  definition_revision_id uuid not null,
  definition_digest text not null check (definition_digest ~ '^[a-f0-9]{64}$'),
  pipeline_id uuid not null,
  github_repository_id uuid,
  selected_stage_ids uuid[] not null check (cardinality(selected_stage_ids) > 0 and array_position(selected_stage_ids, null) is null),
  execution_policy_revision_id uuid,
  model_provider text not null check (btrim(model_provider) <> ''),
  model_name text not null check (btrim(model_name) <> ''),
  title_sha256 text not null check (title_sha256 ~ '^[a-f0-9]{64}$'),
  prompt_sha256 text not null check (prompt_sha256 ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (workspace_id, factory_id, activation_number)
    references public.factory_definition_activations(workspace_id, factory_id, activation_number),
  foreign key (workspace_id, definition_revision_id)
    references public.factory_definition_revisions(workspace_id, id)
);
create index session_factory_admission_inputs_activation_idx
  on public.session_factory_admission_inputs(workspace_id, factory_id, activation_number);
create index session_factory_admission_inputs_revision_idx
  on public.session_factory_admission_inputs(workspace_id, definition_revision_id);

-- These columns are evidence of the original selections. In particular a
-- disconnected GitHub repository may have its current session reference cleared.
alter table public.session_factory_admission_inputs enable row level security;
revoke all on public.session_factory_admission_inputs from public, anon, authenticated, service_role;
grant select on public.session_factory_admission_inputs to service_role;

create function internal.guard_session_factory_admission_inputs()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.sessions where id = old.session_id)
    or not exists (select 1 from public.workspaces where id = old.workspace_id)
  ) then
    return old;
  end if;
  if tg_op <> 'INSERT' then
    raise exception 'Session factory admission inputs are immutable.' using errcode = '23514';
  end if;
  if not exists (
    select 1 from public.sessions s
    join public.factory_definition_activations a
      on (a.workspace_id, a.factory_id, a.activation_number, a.revision_id) =
         (s.workspace_id, new.factory_id, new.activation_number, s.factory_definition_revision_id)
    join public.factory_definition_revisions r
      on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
    where (s.id, s.workspace_id, s.factory_definition_revision_id) =
      (new.session_id, new.workspace_id, new.definition_revision_id)
      and r.canonical_digest = new.definition_digest
  ) then
    raise exception 'Factory admission inputs must match the session pin.' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_factory_admission_inputs() from public, anon, authenticated, service_role;
create trigger guard_session_factory_admission_inputs
  before insert or update or delete on public.session_factory_admission_inputs
  for each row execute function internal.guard_session_factory_admission_inputs();

create or replace function public.create_session_with_first_job(
  target_workspace_id uuid,
  creator_member_id uuid,
  session_title text,
  session_prompt_md text,
  agent_model_provider text,
  agent_model_name text,
  session_linear_issue_id text default null,
  session_linear_issue_url text default null,
  session_github_repository_id uuid default null,
  selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null
)
returns table (
  session_id uuid,
  session_number integer,
  workspace_slug text,
  job_id uuid,
  run_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_number integer;
  created_job_id uuid;
  created_run_id uuid;
  created_session_id uuid;
  first_stage public.pipeline_stages%rowtype;
  pinned_pipeline_id uuid;
  resolved_stage_ids uuid[];
  admitted_factory_id uuid;
  admitted_activation_number bigint;
  admitted_revision_id uuid;
  admitted_definition_digest text;
  effective_execution_policy_revision_id uuid;
begin
  if nullif(btrim(session_title), '') is null then
    raise exception 'Session title must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(session_prompt_md), '') is null then
    raise exception 'Session prompt must not be blank' using errcode = '23514';
  end if;

  if nullif(btrim(agent_model_provider), '') is null
     or nullif(btrim(agent_model_name), '') is null then
    raise exception 'Agent provider and model must not be blank' using errcode = '23514';
  end if;

  if not exists (
    select 1
    from public.workspace_members wm
    where wm.id = creator_member_id
      and wm.workspace_id = target_workspace_id
      and wm.kind = 'human'
      and wm.is_active = true
  ) then
    raise exception 'Creator is not an active human member of workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  if session_github_repository_id is not null
     and not exists (
       select 1
       from public.github_repositories repository
       where repository.id = session_github_repository_id
         and repository.workspace_id = target_workspace_id
         and repository.is_archived = false
     ) then
    raise exception 'Repository is not available for workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  -- Take the workspace admission fence before the pipeline lock. Publication
  -- takes the same workspace row for no-key-update, so a racing create uses
  -- exactly one complete activation and never waits in pipeline/workspace order.
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select a.factory_id, a.activation_number, a.revision_id, r.canonical_digest
  into admitted_factory_id, admitted_activation_number, admitted_revision_id, admitted_definition_digest
  from public.factories f
  join public.factory_definition_activations a on (a.workspace_id, a.factory_id) = (f.workspace_id, f.id)
  join public.factory_definition_revisions r on (r.workspace_id, r.factory_id, r.id) = (a.workspace_id, a.factory_id, a.revision_id)
  where f.workspace_id = target_workspace_id and f.is_default
  order by a.activation_number desc
  limit 1;

  -- Serialize active-stage selection with Settings rewrites. Without the same
  -- pipeline-row lock used by rewrite_default_pipeline, a concurrent create
  -- could snapshot a stage immediately before that stage is archived.
  if selected_pipeline_id is null then
    select pipeline.id
    into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.workspace_id = target_workspace_id
      and pipeline.is_default = true
    for update;
  else
    select pipeline.id
    into pinned_pipeline_id
    from public.pipelines pipeline
    where pipeline.id = selected_pipeline_id
      and pipeline.workspace_id = target_workspace_id
    for update;
  end if;

  if pinned_pipeline_id is null then
    raise exception 'Workspace has no selected or default pipeline configured'
      using errcode = 'P0002';
  end if;

  if selected_stage_ids is null then
    select array_agg(stage.id order by stage.position)
    into resolved_stage_ids
    from public.pipeline_stages stage
    where stage.pipeline_id = pinned_pipeline_id
      and stage.workspace_id = target_workspace_id
      and stage.archived_at is null;
  else
    if cardinality(selected_stage_ids) = 0 then
      raise exception 'Select at least one pipeline stage'
        using errcode = '22023';
    end if;

    if array_position(selected_stage_ids, null) is not null
       or cardinality(selected_stage_ids) <> (
         select count(distinct stage_id)
         from unnest(selected_stage_ids) as selected(stage_id)
       ) then
      raise exception 'Selected pipeline stages must be unique and non-null'
        using errcode = '22023';
    end if;

    select array_agg(stage.id order by stage.position)
    into resolved_stage_ids
    from public.pipeline_stages stage
    where stage.pipeline_id = pinned_pipeline_id
      and stage.workspace_id = target_workspace_id
      and stage.archived_at is null
      and stage.id = any(selected_stage_ids);

    if coalesce(cardinality(resolved_stage_ids), 0) <> cardinality(selected_stage_ids) then
      raise exception 'Selected pipeline stages changed or do not belong to this pipeline'
        using errcode = 'P0003';
    end if;
  end if;

  if coalesce(cardinality(resolved_stage_ids), 0) = 0 then
    raise exception 'Selected pipeline has no stages configured'
      using errcode = 'P0002';
  end if;

  select stage.*
  into first_stage
  from public.pipeline_stages stage
  where stage.id = resolved_stage_ids[1];

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  insert into public.sessions (
    workspace_id,
    number,
    title,
    prompt_md,
    creator_member_id,
    linear_issue_id,
    linear_issue_url,
    pipeline_id,
    current_stage_id,
    phase_status,
    github_repository_id,
    factory_definition_provenance,
    factory_definition_revision_id
  )
  values (
    target_workspace_id,
    allocated_number,
    btrim(session_title),
    btrim(session_prompt_md),
    creator_member_id,
    session_linear_issue_id,
    session_linear_issue_url,
    pinned_pipeline_id,
    first_stage.id,
    'in_progress',
    session_github_repository_id,
    case when admitted_revision_id is null then 'legacy' else 'pinned' end,
    admitted_revision_id
  )
  returning id, execution_policy_revision_id into created_session_id, effective_execution_policy_revision_id;

  if admitted_revision_id is not null then
    insert into public.session_factory_admission_inputs (
      session_id, workspace_id, factory_id, activation_number, definition_revision_id,
      definition_digest, pipeline_id, github_repository_id, selected_stage_ids,
      execution_policy_revision_id, model_provider, model_name, title_sha256, prompt_sha256
    ) values (
      created_session_id, target_workspace_id, admitted_factory_id, admitted_activation_number,
      admitted_revision_id, admitted_definition_digest, pinned_pipeline_id, session_github_repository_id,
      resolved_stage_ids, effective_execution_policy_revision_id, btrim(agent_model_provider), btrim(agent_model_name),
      encode(sha256(convert_to(btrim(session_title), 'UTF8')), 'hex'),
      encode(sha256(convert_to(btrim(session_prompt_md), 'UTF8')), 'hex')
    );
  end if;

  insert into public.session_selected_stages (session_id, workspace_id, stage_id)
  select created_session_id, target_workspace_id, stage.id
  from public.pipeline_stages stage
  where stage.id = any(resolved_stage_ids);

  insert into public.agent_jobs (
    workspace_id,
    session_id,
    requested_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    trigger_type,
    status,
    dedupe_key
  )
  values (
    target_workspace_id,
    created_session_id,
    creator_member_id,
    first_stage.id,
    first_stage.slug,
    first_stage.name,
    'assignment',
    'queued',
    'session:' || created_session_id::text || ':active'
  )
  returning id into created_job_id;

  insert into public.agent_runs (
    workspace_id,
    session_id,
    agent_job_id,
    triggered_by_member_id,
    stage_id,
    stage_slug,
    stage_name,
    run_type,
    model_provider,
    model_name,
    status
  )
  values (
    target_workspace_id,
    created_session_id,
    created_job_id,
    creator_member_id,
    first_stage.id,
    first_stage.slug,
    first_stage.name,
    case when session_github_repository_id is null then 'project' else 'code' end,
    btrim(agent_model_provider),
    btrim(agent_model_name),
    'queued'
  )
  returning id into created_run_id;

  return query
  select
    created_session_id,
    allocated_number,
    workspace.slug,
    created_job_id,
    created_run_id
  from public.workspaces workspace
  where workspace.id = target_workspace_id;
end;
$$;
