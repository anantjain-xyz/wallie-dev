-- One workspace owns an installation for its entire connection lifetime.
-- Refuse legacy ambiguity rather than silently deleting or transferring data.
-- Preflight existing duplicates before applying this migration:
-- select workspace_id, array_agg(id) from public.github_installations
-- group by workspace_id having count(*) > 1;
alter table public.github_installations
  add constraint github_installations_workspace_id_unique unique (workspace_id);

create function internal.preserve_github_installation_ownership()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.workspace_id is distinct from old.workspace_id
    or new.installation_id is distinct from old.installation_id then
    raise exception 'GitHub installation ownership is immutable; disconnect before reconnecting'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

revoke all on function internal.preserve_github_installation_ownership()
  from public, anon, authenticated;

create trigger github_installations_preserve_ownership
before update of workspace_id, installation_id
on public.github_installations
for each row execute function internal.preserve_github_installation_ownership();

-- The server holds the PKCE verifier encrypted and consumes each OAuth flow.
-- Public clients must never read the verifier or mutate a flow's identity.
create table public.github_install_flows (
  state_hash text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  source text not null,
  encrypted_code_verifier text not null,
  installation_id bigint,
  phase text not null default 'install',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint github_install_flows_state_hash_check
    check (state_hash ~ '^[a-f0-9]{64}$'),
  constraint github_install_flows_source_check
    check (source in ('settings', 'onboarding')),
  constraint github_install_flows_installation_id_check
    check (installation_id is null or installation_id > 0),
  constraint github_install_flows_phase_check
    check (phase in ('install', 'authorize')),
  constraint github_install_flows_phase_installation_check
    check (
      (phase = 'install' and installation_id is null)
      or (phase = 'authorize' and installation_id is not null)
    )
);

create index github_install_flows_expires_at_idx
  on public.github_install_flows (expires_at);

alter table public.github_install_flows enable row level security;
revoke all on public.github_install_flows from public, anon, authenticated;
grant select, insert, update, delete on public.github_install_flows to service_role;
