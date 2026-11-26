create function internal.freeze_factory_benchmark_experiment_axes_with_pins(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql set search_path = '' as $$
declare
  choices jsonb := p_candidates;
  receipt jsonb;
begin
  if jsonb_typeof(p_candidates) = 'array' then
    select coalesce(jsonb_agg(
      case when jsonb_typeof(choice.value) = 'object'
        then choice.value - 'expectedToolchainDigest' else choice.value end order by choice.position
    ), '[]'::jsonb) into choices
    from jsonb_array_elements(p_candidates) with ordinality as choice(value, position);
  end if;

  receipt := internal.freeze_factory_benchmark_experiment_axes(
    p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, choices, p_repetitions, p_seed, p_timeout_ms
  );

  if exists (
    select 1
    from jsonb_array_elements(p_candidates) with ordinality as choice(value, position)
    where choice.value ? 'expectedToolchainDigest'
      and not exists (
        select 1 from public.factory_benchmark_experiment_candidates candidate
        where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id, candidate.comparison_position) =
          (p_workspace_id, p_factory_id, p_experiment_id, choice.position)
          and candidate.toolchain_digest = choice.value->>'expectedToolchainDigest'
      )
  ) then
    raise exception 'A selected toolchain pin changed.' using errcode = 'PT412';
  end if;
  return receipt;
end;
$$;
revoke all on function internal.freeze_factory_benchmark_experiment_axes_with_pins(
  uuid,uuid,uuid,uuid,uuid,uuid,jsonb,integer,integer,integer
) from public, anon, authenticated, service_role;

create or replace function public.freeze_factory_benchmark_experiment_axes(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_experiment_id uuid,
  p_suite_revision_id uuid, p_policy_revision_id uuid, p_candidates jsonb,
  p_repetitions integer, p_seed integer, p_timeout_ms integer
) returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform internal.require_factory_benchmark_evaluation_freeze(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, null
  );
  return internal.freeze_factory_benchmark_experiment_axes_with_pins(
    p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms
  );
end;
$$;

create or replace function public.freeze_factory_benchmark_experiment_axes_with_evaluation(
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
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, p_evaluation_plan
  );
  receipt := internal.freeze_factory_benchmark_experiment_axes_with_pins(
    p_workspace_id, p_factory_id, p_actor_user_id, p_experiment_id,
    p_suite_revision_id, p_policy_revision_id, p_candidates, p_repetitions, p_seed, p_timeout_ms
  );
  return receipt || internal.bind_factory_benchmark_evaluation_plan(
    p_workspace_id, p_factory_id, p_experiment_id, p_actor_user_id, plan
  );
end;
$$;
