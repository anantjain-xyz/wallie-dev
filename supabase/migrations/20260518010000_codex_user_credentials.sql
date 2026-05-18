alter table public.user_codex_credentials
  add column credential_type text not null default 'codex_access_token',
  add column encrypted_credential text;

update public.user_codex_credentials
set encrypted_credential = encrypted_access_token
where encrypted_credential is null;

alter table public.user_codex_credentials
  alter column encrypted_credential set not null,
  alter column access_token_expires_at drop not null,
  add constraint user_codex_credentials_credential_type_check
    check (credential_type in ('codex_access_token', 'platform_api_key'));

alter table public.user_codex_credentials
  drop column encrypted_access_token,
  drop column encrypted_refresh_token;
