-- Keep Settings usage aggregation inside Postgres so successful run rows are not
-- transferred to the application just to be reduced to four totals.
create index agent_runs_workspace_success_usage_idx
  on public.agent_runs (workspace_id)
  include (input_tokens, output_tokens, total_cost_usd)
  where status = 'success';

create or replace function public.get_workspace_usage(target_workspace_id uuid)
returns table (
  total_input_tokens bigint,
  total_output_tokens bigint,
  total_cost_usd numeric,
  total_runs bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    coalesce(sum(run.input_tokens), 0)::bigint as total_input_tokens,
    coalesce(sum(run.output_tokens), 0)::bigint as total_output_tokens,
    coalesce(sum(run.total_cost_usd), 0)::numeric as total_cost_usd,
    count(run.id)::bigint as total_runs
  from (
    select target_workspace_id as workspace_id
    where target_workspace_id in (select internal.current_user_workspace_ids())
  ) permitted_workspace
  left join public.agent_runs run
    on run.workspace_id = permitted_workspace.workspace_id
   and run.status = 'success'
  group by permitted_workspace.workspace_id;
$$;

revoke all on function public.get_workspace_usage(uuid) from public, anon;
grant execute on function public.get_workspace_usage(uuid) to authenticated, service_role;
