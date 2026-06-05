-- Atomically claim the oldest ready job whose workspace still has capacity.
-- This avoids a global candidate-window head-of-line block where the oldest
-- ready rows all belong to a workspace that is already at its concurrency cap.
create or replace function public.claim_next_agent_job(
  default_concurrency_limit int default 2
)
returns setof public.agent_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  candidate public.agent_jobs%rowtype;
  configured_limit int;
  effective_limit int;
  running_count int;
begin
  for candidate in
    select *
    from public.agent_jobs
    where status = 'queued'
      and (scheduled_at is null or scheduled_at <= now())
    order by created_at asc
    for update skip locked
  loop
    configured_limit := null;

    select (value_json)::int into configured_limit
    from public.workspace_agent_config
    where workspace_id = candidate.workspace_id
      and key = 'concurrency_limit'
      and jsonb_typeof(value_json) = 'number';

    effective_limit := coalesce(configured_limit, default_concurrency_limit);

    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    select count(*) into running_count
    from public.agent_jobs
    where workspace_id = candidate.workspace_id
      and status = 'running';

    if running_count >= effective_limit then
      continue;
    end if;

    return query
    update public.agent_jobs
    set
      status = 'running',
      attempt_count = attempt_count + 1,
      last_error = null,
      started_at = coalesce(started_at, now()),
      scheduled_at = null
    where id = candidate.id
      and status = 'queued'
    returning *;

    return;
  end loop;

  return;
end;
$$;

revoke all on function public.claim_next_agent_job(integer) from public, anon, authenticated;
grant execute on function public.claim_next_agent_job(integer) to service_role;
