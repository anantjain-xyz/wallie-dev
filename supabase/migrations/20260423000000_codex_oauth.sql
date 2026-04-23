-- Per-user Codex (ChatGPT) OAuth credentials.
--
-- Wallie runs coding agents on behalf of the session owner. When the agent
-- provider is `codex`, the runner spawns the Codex CLI as a subprocess and
-- injects the owner's OAuth tokens. Tokens are stored encrypted with the
-- same AES-256-GCM scheme used by workspace_secrets
-- (see src/lib/secrets/crypto.ts).

create table public.user_codex_credentials (
  user_id uuid primary key references auth.users(id) on delete cascade,
  encrypted_access_token text not null,
  encrypted_refresh_token text not null,
  access_token_expires_at timestamptz not null,
  scope text,
  account_id text,
  account_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger user_codex_credentials_touch_updated_at
before update on public.user_codex_credentials
for each row execute function internal.touch_updated_at();

alter table public.user_codex_credentials enable row level security;

revoke all on public.user_codex_credentials from anon, authenticated;

-- Authenticated users can read their own row (to render connection status)
-- and delete it (to disconnect). Inserts and updates go through the
-- service role from the OAuth callback.
grant select, delete on public.user_codex_credentials to authenticated;

create policy user_codex_credentials_select_self
  on public.user_codex_credentials
  for select
  to authenticated
  using (user_id = auth.uid());

create policy user_codex_credentials_delete_self
  on public.user_codex_credentials
  for delete
  to authenticated
  using (user_id = auth.uid());
