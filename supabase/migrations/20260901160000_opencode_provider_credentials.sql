-- Per-provider OpenCode API keys (user-scoped). OpenCode looks up auth.json
-- entries by the provider id before the first slash in the model reference
-- (e.g. `opencode-go/glm-5.3` → `opencode-go`). The reserved Zen `opencode`
-- prefix stays on user_opencode_credentials so the two paths cannot shadow
-- each other. provider_id reuses AGENT_MODEL_BODY_PATTERN from
-- src/lib/agent-config/contracts.ts.

create table public.user_opencode_provider_credentials (
  user_id uuid not null references auth.users(id) on delete cascade,
  provider_id text not null,
  encrypted_api_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, provider_id),
  constraint user_opencode_provider_credentials_provider_id_syntax
    check (
      char_length(provider_id) between 1 and 100
      and provider_id <> 'opencode'
      and provider_id ~ '^[a-z0-9]([a-z0-9._-]{0,98}[a-z0-9])?$'
    )
);

create trigger user_opencode_provider_credentials_touch_updated_at
before update on public.user_opencode_provider_credentials
for each row
execute function internal.touch_updated_at();

alter table public.user_opencode_provider_credentials enable row level security;

revoke all on public.user_opencode_provider_credentials from public, anon, authenticated;
grant all on public.user_opencode_provider_credentials to service_role;
grant select, delete on public.user_opencode_provider_credentials to authenticated;

create policy user_opencode_provider_credentials_select_self
  on public.user_opencode_provider_credentials
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

create policy user_opencode_provider_credentials_delete_self
  on public.user_opencode_provider_credentials
  for delete
  to authenticated
  using ((select auth.uid()) = user_id);
