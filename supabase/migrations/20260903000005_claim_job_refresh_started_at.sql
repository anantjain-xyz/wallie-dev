-- Refresh started_at on every claim so stall age measures this attempt.
--
-- `claim_next_agent_job` used `started_at = coalesce(started_at, now())`, so a
-- retried job kept its original timestamp. The runless-job stall sweep then
-- treated a just-reclaimed job as already expired and could requeue it during
-- the claim → startAgentRun gap, overlapping the live processor.

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
  selected_provider text;
begin
  delete from public.workspace_sandbox_connection_mutations where expires_at <= now();

  for candidate in
    select * from public.agent_jobs
    where status = 'queued' and (scheduled_at is null or scheduled_at <= now())
    order by created_at asc for update skip locked
  loop
    perform pg_advisory_xact_lock(hashtextextended(candidate.workspace_id::text, 0));

    select active_provider into selected_provider
    from public.workspace_sandbox_settings where workspace_id = candidate.workspace_id;
    selected_provider := coalesce(selected_provider, 'vercel');

    if exists (
      select 1 from public.workspace_sandbox_connection_mutations
      where workspace_id = candidate.workspace_id
        and provider = selected_provider
        and expires_at > now()
    ) then continue; end if;

    configured_limit := null;
    select (value_json)::int into configured_limit
    from public.workspace_agent_config
    where workspace_id = candidate.workspace_id
      and key = 'concurrency_limit'
      and jsonb_typeof(value_json) = 'number';

    effective_limit := coalesce(configured_limit, default_concurrency_limit);
    select count(*) into running_count from public.agent_jobs
    where workspace_id = candidate.workspace_id and status = 'running';
    if running_count >= effective_limit then continue; end if;

    return query
    update public.agent_jobs
    set status = 'running', attempt_count = attempt_count + 1, last_error = null,
        started_at = now(), scheduled_at = null
    where id = candidate.id and status = 'queued'
    returning *;
    return;
  end loop;
  return;
end;
$$;

revoke all on function public.claim_next_agent_job(integer)
  from public, anon, authenticated;
grant execute on function public.claim_next_agent_job(integer) to service_role;
