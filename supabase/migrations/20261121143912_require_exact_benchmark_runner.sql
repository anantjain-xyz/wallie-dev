create function internal.require_exact_benchmark_runner()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.runner_revision = 'recorded-fixture-v1' and exists (
    select 1 from public.factory_benchmark_experiment_candidates candidate
    where (candidate.workspace_id, candidate.factory_id, candidate.experiment_id) =
      (new.workspace_id, new.factory_id, new.experiment_id)
      and candidate.qualification_id is not null
  ) then
    raise exception 'This comparison requires a runner that uses the pinned configurations.' using errcode = 'PT412';
  end if;
  return new;
end;
$$;
revoke all on function internal.require_exact_benchmark_runner() from public, anon, authenticated, service_role;

create trigger require_exact_benchmark_runner
before insert or update of runner_revision on public.factory_benchmark_schedules
for each row execute function internal.require_exact_benchmark_runner();
