-- Drop Stripe billing surface. Wallie no longer enforces tier-based quotas;
-- the columns and enum are removed entirely so the schema reflects shipped reality.

alter table public.workspaces
  drop constraint if exists workspaces_successful_agent_runs_nonnegative_check;

alter table public.workspaces
  drop column if exists stripe_customer_id,
  drop column if exists successful_agent_runs_this_cycle,
  drop column if exists current_billing_cycle_start_at,
  drop column if exists tier;

drop type if exists public.workspace_tier;
