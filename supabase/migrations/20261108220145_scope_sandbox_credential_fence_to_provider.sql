create or replace function internal.preserve_deleting_workspace_credentials()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  target uuid;
  credential_provider text;
begin
  target := case when tg_op = 'DELETE' then old.workspace_id else new.workspace_id end;
  if tg_op = 'DELETE' and not exists(select 1 from public.workspaces where id = target) then return old; end if;

  case tg_table_name
    when 'workspace_vercel_sandbox_connections' then credential_provider := 'vercel';
    when 'workspace_e2b_sandbox_connections' then credential_provider := 'e2b';
    when 'workspace_daytona_sandbox_connections' then credential_provider := 'daytona';
  end case;

  -- Serialize with acquisition admission and keep the credentials that its cleanup needs.
  perform 1 from public.workspaces where id = target for update;
  perform internal.assert_workspace_accepts_work(target);
  if exists(select 1 from public.workspace_resource_operations
    where workspace_id = target and kind = 'sandbox' and provider = credential_provider) then
    raise exception 'Sandbox acquisition cleanup is still pending.' using errcode = 'P0010';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
