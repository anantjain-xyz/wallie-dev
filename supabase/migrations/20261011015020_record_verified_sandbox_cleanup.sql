-- Historical sandbox IDs remain useful audit metadata after disconnection.
-- Only a verified stop under the recorded provider revision retires ownership.
create table public.workspace_sandbox_cleanup_receipts (
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  provider text not null check (provider in ('vercel','e2b','daytona')),
  connection_revision uuid not null,
  sandbox_id text not null,
  confirmed_at timestamptz not null default now(),
  primary key (workspace_id,provider,connection_revision,sandbox_id)
);
alter table public.workspace_sandbox_cleanup_receipts enable row level security;
revoke all on public.workspace_sandbox_cleanup_receipts from public,anon,authenticated;
grant all on public.workspace_sandbox_cleanup_receipts to service_role;
