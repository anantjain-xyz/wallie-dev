-- Previous application versions stored secrets of six characters or fewer
-- verbatim in preview metadata. Keep ciphertext intact and remove those copies.
update public.workspace_secrets
set value_preview = '••••'
where char_length(value_preview) between 1 and 6
  and value_preview <> '••••';

-- Preview-only cleanup must not rotate connection identity: active sandboxes
-- still belong to the same credentials. These changes run in the migration's
-- transaction, so any failure also rolls back the trigger state.
alter table public.workspace_vercel_sandbox_connections
  disable trigger workspace_vercel_sandbox_connections_rotate_revision;
alter table public.workspace_e2b_sandbox_connections
  disable trigger workspace_e2b_sandbox_connections_rotate_revision;
alter table public.workspace_daytona_sandbox_connections
  disable trigger workspace_daytona_sandbox_connections_rotate_revision;

update public.workspace_vercel_sandbox_connections
set token_preview = '••••'
where char_length(token_preview) between 1 and 6
  and token_preview <> '••••';

update public.workspace_e2b_sandbox_connections
set api_key_preview = '••••'
where char_length(api_key_preview) between 1 and 6
  and api_key_preview <> '••••';

update public.workspace_daytona_sandbox_connections
set api_key_preview = '••••'
where char_length(api_key_preview) between 1 and 6
  and api_key_preview <> '••••';

alter table public.workspace_vercel_sandbox_connections
  enable trigger workspace_vercel_sandbox_connections_rotate_revision;
alter table public.workspace_e2b_sandbox_connections
  enable trigger workspace_e2b_sandbox_connections_rotate_revision;
alter table public.workspace_daytona_sandbox_connections
  enable trigger workspace_daytona_sandbox_connections_rotate_revision;
