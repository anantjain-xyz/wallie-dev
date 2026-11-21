create table public.factory_benchmark_evaluation_plans (
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  budget_limit_usd numeric(13,6) not null check (budget_limit_usd between 0 and 1000000),
  created_by uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key (workspace_id, factory_id, experiment_id),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_experiments(workspace_id, factory_id, id) on delete cascade
);

create table public.factory_benchmark_evaluation_dimensions (
  workspace_id uuid not null,
  factory_id uuid not null,
  experiment_id uuid not null,
  scorer_revision_id uuid not null,
  primary key (workspace_id, factory_id, experiment_id, scorer_revision_id),
  foreign key (workspace_id, factory_id, experiment_id)
    references public.factory_benchmark_evaluation_plans(workspace_id, factory_id, experiment_id) on delete cascade,
  foreign key (workspace_id, factory_id, scorer_revision_id)
    references public.factory_scorer_revisions(workspace_id, factory_id, id) on delete cascade
);
create index factory_benchmark_evaluation_dimensions_revision_idx
  on public.factory_benchmark_evaluation_dimensions(workspace_id, factory_id, scorer_revision_id);

alter table public.factory_benchmark_evaluation_plans enable row level security;
alter table public.factory_benchmark_evaluation_dimensions enable row level security;
revoke all on public.factory_benchmark_evaluation_plans, public.factory_benchmark_evaluation_dimensions
  from public, anon, authenticated, service_role;
grant select on public.factory_benchmark_evaluation_plans, public.factory_benchmark_evaluation_dimensions to service_role;

create function internal.preserve_factory_benchmark_evaluation_plan()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' and (
    not exists (select 1 from public.factories factory
      where (factory.workspace_id, factory.id) = (old.workspace_id, old.factory_id))
    or not exists (select 1 from public.factory_benchmark_experiments experiment
      where (experiment.workspace_id, experiment.factory_id, experiment.id) = (old.workspace_id, old.factory_id, old.experiment_id))
  ) then return old; end if;
  raise exception 'The benchmark evaluation plan is immutable.' using errcode = '23514';
end;
$$;
create trigger preserve_factory_benchmark_evaluation_plan
  before update or delete on public.factory_benchmark_evaluation_plans
  for each row execute function internal.preserve_factory_benchmark_evaluation_plan();
create trigger preserve_factory_benchmark_evaluation_dimensions
  before update or delete on public.factory_benchmark_evaluation_dimensions
  for each row execute function internal.preserve_factory_benchmark_evaluation_plan();

create function internal.factory_benchmark_evaluation_plan(p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid)
returns jsonb language sql stable set search_path = '' as $$
  select jsonb_build_object('budgetLimitUsd', plan.budget_limit_usd,
    'scorerRevisionIds', (select jsonb_agg(dimension.scorer_revision_id order by dimension.scorer_revision_id)
      from public.factory_benchmark_evaluation_dimensions dimension
      where (dimension.workspace_id, dimension.factory_id, dimension.experiment_id) =
        (plan.workspace_id, plan.factory_id, plan.experiment_id)))
  from public.factory_benchmark_evaluation_plans plan
  where (plan.workspace_id, plan.factory_id, plan.experiment_id) = (p_workspace_id, p_factory_id, p_experiment_id);
$$;

create function internal.require_factory_benchmark_evaluation_freeze(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid, p_evaluation_plan jsonb
) returns jsonb language plpgsql set search_path = '' as $$
declare
  budget numeric;
  scorer_ids uuid[];
  normalized jsonb;
begin
  perform internal.assert_checkpoint_publication_service();
  -- Every legacy/new entry point uses the same factory lock as the matrix freeze.
  perform internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);

  if p_evaluation_plan is not null then
    if jsonb_typeof(p_evaluation_plan) is distinct from 'object'
      or p_evaluation_plan - array['scorerRevisionIds', 'budgetLimitUsd'] <> '{}'::jsonb
      or jsonb_typeof(p_evaluation_plan->'scorerRevisionIds') is distinct from 'array'
      or jsonb_typeof(p_evaluation_plan->'budgetLimitUsd') is distinct from 'number'
    then raise exception 'Provide exact scorer revisions and an evaluation budget.' using errcode = '22023'; end if;

    budget := (p_evaluation_plan->>'budgetLimitUsd')::numeric;
    if budget not between 0 and 1000000 or budget <> round(budget, 6)
      or jsonb_array_length(p_evaluation_plan->'scorerRevisionIds') not between 1 and 16
      or exists (select 1 from jsonb_array_elements(p_evaluation_plan->'scorerRevisionIds') ids(value)
        where jsonb_typeof(value) <> 'string' or not coalesce(pg_input_is_valid(value#>>'{}', 'uuid'), false))
    then raise exception 'Invalid benchmark evaluation selections.' using errcode = '22023'; end if;

    select array_agg(distinct id::uuid order by id::uuid) into scorer_ids
    from jsonb_array_elements_text(p_evaluation_plan->'scorerRevisionIds') requested(id);
    if cardinality(scorer_ids) <> jsonb_array_length(p_evaluation_plan->'scorerRevisionIds') then
      raise exception 'Select distinct scorer revisions.' using errcode = '22023';
    end if;
    normalized := jsonb_build_object('budgetLimitUsd', budget, 'scorerRevisionIds', scorer_ids);
  end if;

  if exists (select 1 from public.factory_benchmark_experiments frozen
    where (frozen.workspace_id, frozen.factory_id, frozen.id) = (p_workspace_id, p_factory_id, p_experiment_id))
  then
    if normalized is distinct from internal.factory_benchmark_evaluation_plan(p_workspace_id, p_factory_id, p_experiment_id) then
      raise exception 'The experiment identity already refers to a different evaluation plan.' using errcode = 'PT409';
    end if;
  elsif normalized is not null and (select count(*) from public.factory_scorer_revisions scorer
    where (scorer.workspace_id, scorer.factory_id) = (p_workspace_id, p_factory_id) and scorer.id = any(scorer_ids))
    <> cardinality(scorer_ids)
  then
    raise exception 'A selected scorer revision is unavailable in this factory.' using errcode = 'PT422';
  end if;
  return normalized;
end;
$$;

create function internal.bind_factory_benchmark_evaluation_plan(
  p_workspace_id uuid, p_factory_id uuid, p_experiment_id uuid, p_actor_user_id uuid, p_normalized jsonb
) returns jsonb language plpgsql set search_path = '' as $$
begin
  insert into public.factory_benchmark_evaluation_plans(workspace_id, factory_id, experiment_id, budget_limit_usd, created_by)
  values (p_workspace_id, p_factory_id, p_experiment_id, (p_normalized->>'budgetLimitUsd')::numeric, p_actor_user_id)
  on conflict (workspace_id, factory_id, experiment_id) do nothing;
  if found then
    insert into public.factory_benchmark_evaluation_dimensions(workspace_id, factory_id, experiment_id, scorer_revision_id)
    select p_workspace_id, p_factory_id, p_experiment_id, selected.id::uuid
    from jsonb_array_elements_text(p_normalized->'scorerRevisionIds') selected(id);
  end if;
  return jsonb_build_object('evaluation', internal.factory_benchmark_evaluation_plan(p_workspace_id, p_factory_id, p_experiment_id));
end;
$$;

revoke all on function internal.preserve_factory_benchmark_evaluation_plan(),
  internal.factory_benchmark_evaluation_plan(uuid,uuid,uuid),
  internal.require_factory_benchmark_evaluation_freeze(uuid,uuid,uuid,uuid,jsonb),
  internal.bind_factory_benchmark_evaluation_plan(uuid,uuid,uuid,uuid,jsonb)
  from public, anon, authenticated, service_role;

alter function public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer) set schema internal;
revoke all on function internal.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer)
  from public, anon, authenticated, service_role;

create function public.freeze_factory_benchmark_experiment(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_factory_benchmark_evaluation_freeze(p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, null);
  return internal.freeze_factory_benchmark_experiment(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms);
end;
$$;

create function public.freeze_factory_benchmark_experiment_with_evaluation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer, p_evaluation_plan jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  plan jsonb;
  receipt jsonb;
begin
  if p_evaluation_plan is null then raise exception 'Provide an evaluation plan.' using errcode = '22023'; end if;
  plan := internal.require_factory_benchmark_evaluation_freeze(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, p_evaluation_plan);
  receipt := internal.freeze_factory_benchmark_experiment(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms);
  return receipt || internal.bind_factory_benchmark_evaluation_plan(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, plan);
end;
$$;

alter function public.freeze_factory_benchmark_experiment_axes(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer) set schema internal;
revoke all on function internal.freeze_factory_benchmark_experiment_axes(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer)
  from public, anon, authenticated, service_role;

create function public.freeze_factory_benchmark_experiment_axes(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_factory_benchmark_evaluation_freeze(p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, null);
  return internal.freeze_factory_benchmark_experiment_axes(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms);
end;
$$;

create function public.freeze_factory_benchmark_experiment_axes_with_evaluation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer, p_evaluation_plan jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  plan jsonb;
  receipt jsonb;
begin
  if p_evaluation_plan is null then raise exception 'Provide an evaluation plan.' using errcode = '22023'; end if;
  plan := internal.require_factory_benchmark_evaluation_freeze(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, p_evaluation_plan);
  receipt := internal.freeze_factory_benchmark_experiment_axes(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms);
  return receipt || internal.bind_factory_benchmark_evaluation_plan(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, plan);
end;
$$;

alter function public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text) set schema internal;
revoke all on function internal.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text)
  from public, anon, authenticated, service_role;

create function public.find_factory_benchmark_experiment_retry(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_definition_revision_ids uuid[],
  p_repetitions integer, p_seed integer, p_timeout_ms integer, p_worker_runtime text default 'node'
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_factory_benchmark_evaluation_freeze(p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, null);
  return internal.find_factory_benchmark_experiment_retry(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_definition_revision_ids, p_repetitions, p_seed, p_timeout_ms, p_worker_runtime);
end;
$$;

create function public.find_factory_benchmark_experiment_retry_with_evaluation(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_definition_revision_ids uuid[],
  p_repetitions integer, p_seed integer, p_timeout_ms integer, p_worker_runtime text, p_evaluation_plan jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  plan jsonb;
  receipt jsonb;
begin
  if p_evaluation_plan is null then raise exception 'Provide an evaluation plan.' using errcode = '22023'; end if;
  plan := internal.require_factory_benchmark_evaluation_freeze(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, p_evaluation_plan);
  receipt := internal.find_factory_benchmark_experiment_retry(p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_definition_revision_ids, p_repetitions, p_seed, p_timeout_ms, p_worker_runtime);
  if receipt is null then return null; end if;
  return receipt || jsonb_build_object('evaluation', plan);
end;
$$;

revoke all on function
  public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer),
  public.freeze_factory_benchmark_experiment_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer,jsonb),
  public.freeze_factory_benchmark_experiment_axes(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer),
  public.freeze_factory_benchmark_experiment_axes_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer,jsonb),
  public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text),
  public.find_factory_benchmark_experiment_retry_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function
  public.freeze_factory_benchmark_experiment(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer),
  public.freeze_factory_benchmark_experiment_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer,jsonb),
  public.freeze_factory_benchmark_experiment_axes(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer),
  public.freeze_factory_benchmark_experiment_axes_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer,jsonb),
  public.find_factory_benchmark_experiment_retry(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text),
  public.find_factory_benchmark_experiment_retry_with_evaluation(uuid,uuid,uuid,uuid,uuid,uuid,uuid[],integer,integer,integer,text,jsonb)
  to service_role;
