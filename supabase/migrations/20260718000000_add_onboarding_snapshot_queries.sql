-- Keep onboarding snapshot reads bounded without splitting a source across queries.

create index if not exists sandbox_capability_checks_workspace_repository_checked_idx
  on public.sandbox_capability_checks (
    workspace_id,
    github_repository_id,
    checked_at desc,
    id desc
  );

create or replace function public.load_workspace_onboarding_secret_previews(
  target_workspace_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with preview_rows as (
    select
      secret.created_at,
      secret.created_by_member_id,
      secret.id,
      secret.key,
      secret.updated_at,
      secret.value_preview,
      secret.workspace_id
    from public.workspace_secrets secret
    where secret.workspace_id = target_workspace_id
  )
  select jsonb_build_object(
    'linear_secret', (
      select to_jsonb(linear_secret)
      from preview_rows linear_secret
      where linear_secret.key = 'LINEAR_API_KEY'
    ),
    'secret_rows', coalesce(
      (
        select jsonb_agg(to_jsonb(listed_secret) order by listed_secret.key asc)
        from (
          select *
          from preview_rows
          order by key asc
          limit 1000
        ) listed_secret
      ),
      '[]'::jsonb
    )
  );
$$;

create or replace function public.load_workspace_onboarding_sandbox_checks(
  target_workspace_id uuid
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'capabilities', latest.capabilities,
        'checked_at', latest.checked_at,
        'error_text', latest.error_text,
        'github_repository_id', latest.github_repository_id,
        'id', latest.id,
        'sandbox_provider', latest.sandbox_provider,
        'sandbox_vercel_project_id', latest.sandbox_vercel_project_id,
        'sandbox_vercel_team_id', latest.sandbox_vercel_team_id,
        'status', latest.status
      )
      order by latest.checked_at desc, latest.id desc
    ),
    '[]'::jsonb
  )
  from (
    select distinct on (check_row.github_repository_id)
      check_row.capabilities,
      check_row.checked_at,
      check_row.error_text,
      check_row.github_repository_id,
      check_row.id,
      check_row.sandbox_provider,
      check_row.sandbox_vercel_project_id,
      check_row.sandbox_vercel_team_id,
      check_row.status
    from public.sandbox_capability_checks check_row
    where check_row.workspace_id = target_workspace_id
    order by
      check_row.github_repository_id,
      check_row.checked_at desc,
      check_row.id desc
  ) latest;
$$;

revoke all on function public.load_workspace_onboarding_secret_previews(uuid)
  from public, anon, authenticated;
revoke all on function public.load_workspace_onboarding_sandbox_checks(uuid)
  from public, anon, authenticated;

grant execute on function public.load_workspace_onboarding_secret_previews(uuid)
  to service_role;
grant execute on function public.load_workspace_onboarding_sandbox_checks(uuid)
  to service_role;
