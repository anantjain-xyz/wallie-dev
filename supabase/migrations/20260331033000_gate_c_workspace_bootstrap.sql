create or replace function internal.slugify_workspace_value(input text)
returns text
language sql
immutable
set search_path = ''
as $$
  select trim(
    both '-'
    from regexp_replace(
      regexp_replace(lower(coalesce(input, '')), '[^a-z0-9]+', '-', 'g'),
      '-{2,}',
      '-',
      'g'
    )
  )
$$;

create or replace function public.create_workspace(
  workspace_name text,
  requested_slug text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor_id uuid := auth.uid();
  actor_email text := nullif(auth.jwt() ->> 'email', '');
  actor_full_name text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'full_name',
      auth.jwt() -> 'user_metadata' ->> 'name'
    ),
    ''
  );
  actor_avatar_url text := nullif(
    coalesce(
      auth.jwt() -> 'user_metadata' ->> 'avatar_url',
      auth.jwt() -> 'user_metadata' ->> 'picture'
    ),
    ''
  );
  base_slug text;
  candidate_slug text;
  suffix integer := 0;
  created_workspace public.workspaces%rowtype;
  profile_row public.profiles%rowtype;
begin
  if actor_id is null then
    raise exception 'Authenticated user required to create a workspace'
      using errcode = '42501';
  end if;

  workspace_name := btrim(coalesce(workspace_name, ''));

  if workspace_name = '' then
    raise exception 'workspace_name is required'
      using errcode = '22023';
  end if;

  base_slug := internal.slugify_workspace_value(
    coalesce(nullif(btrim(requested_slug), ''), workspace_name)
  );

  if base_slug = '' then
    base_slug := 'workspace';
  end if;

  candidate_slug := base_slug;

  while exists (
    select 1
    from public.workspaces workspace_record
    where workspace_record.slug = candidate_slug
  ) loop
    suffix := suffix + 1;
    candidate_slug := base_slug || '-' || suffix;
  end loop;

  select *
  into profile_row
  from public.profiles profile_record
  where profile_record.id = actor_id;

  insert into public.workspaces (
    slug,
    name,
    created_by
  )
  values (
    candidate_slug,
    workspace_name,
    actor_id
  )
  returning *
  into created_workspace;

  insert into public.workspace_members (
    workspace_id,
    user_id,
    kind,
    role,
    email,
    full_name,
    avatar_url
  )
  values (
    created_workspace.id,
    actor_id,
    'human',
    'owner',
    coalesce(profile_row.primary_email, actor_email),
    coalesce(profile_row.full_name, actor_full_name),
    coalesce(profile_row.avatar_url, actor_avatar_url)
  );

  insert into public.workspace_members (
    workspace_id,
    kind,
    role,
    username,
    full_name
  )
  values (
    created_workspace.id,
    'system',
    'agent',
    'wallie',
    'Wallie'
  );

  insert into internal.workspace_issue_counters (
    workspace_id,
    last_issue_number
  )
  values (
    created_workspace.id,
    0
  )
  on conflict (workspace_id) do nothing;

  return created_workspace;
end;
$$;

grant execute on function public.create_workspace(text, text) to authenticated;
