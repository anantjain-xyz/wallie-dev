-- Security advisor cleanup:
-- - GraphQL is unused by Wallie, so remove the GraphQL surface.
-- - Move RLS helper RPCs out of the exposed public schema.
-- - Restrict privileged SECURITY DEFINER functions to service_role.
-- - Add explicit deny policies for service-only tables.

drop extension if exists pg_graphql cascade;

create or replace function internal.current_user_workspace_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select wm.workspace_id
  from public.workspace_members wm
  where wm.user_id = auth.uid()
    and wm.kind = 'human'
    and wm.is_active = true
$$;

create or replace function internal.can_manage_workspace(target_workspace_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(
      auth.role() = 'service_role'
      or exists (
        select 1
        from public.workspace_members wm
        where wm.workspace_id = target_workspace_id
          and wm.user_id = auth.uid()
          and wm.kind = 'human'
          and wm.is_active = true
          and wm.role in ('owner', 'admin')
      ),
      false
    )
$$;

grant execute on function internal.current_user_workspace_ids() to authenticated, service_role;
grant execute on function internal.can_manage_workspace(uuid) to authenticated, service_role;

alter policy workspaces_select_membership
  on public.workspaces
  using (id in (select internal.current_user_workspace_ids()));

alter policy workspace_members_select_membership
  on public.workspace_members
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_members_update_own_preferences
  on public.workspace_members
  using (user_id = auth.uid() and workspace_id in (select internal.current_user_workspace_ids()))
  with check (user_id = auth.uid() and workspace_id in (select internal.current_user_workspace_ids()));

alter policy github_installations_select_membership
  on public.github_installations
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy github_repositories_select_membership
  on public.github_repositories
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy github_issue_branches_select_membership
  on public.github_issue_branches
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy agent_runs_select_membership
  on public.agent_runs
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy agent_run_messages_select_membership
  on public.agent_run_messages
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy sessions_select_membership
  on public.sessions
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy sessions_insert_membership
  on public.sessions
  with check (
    workspace_id in (select internal.current_user_workspace_ids())
    and workspace_id in (
      select onboarding.workspace_id
      from public.workspace_onboarding onboarding
      where onboarding.status = 'completed'
    )
    and phase_status = 'agent_generating'
    and current_artifact_version = 0
    and rejection_count = 0
    and archived_at is null
  );

alter policy session_artifacts_select_membership
  on public.session_artifacts
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy session_artifact_feedback_select_membership
  on public.session_artifact_feedback
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy session_phase_completions_select_membership
  on public.session_phase_completions
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy session_pull_requests_select_membership
  on public.session_pull_requests
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_agent_config_select
  on public.workspace_agent_config
  to authenticated
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_agent_config_insert
  on public.workspace_agent_config
  to authenticated
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_agent_config_update
  on public.workspace_agent_config
  to authenticated
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_agent_config_delete
  on public.workspace_agent_config
  to authenticated
  using (internal.can_manage_workspace(workspace_id));

alter policy pipelines_select_membership
  on public.pipelines
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy pipelines_insert_manager
  on public.pipelines
  with check (internal.can_manage_workspace(workspace_id));

alter policy pipelines_update_manager
  on public.pipelines
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy pipelines_delete_manager
  on public.pipelines
  using (internal.can_manage_workspace(workspace_id));

alter policy pipeline_stages_select_membership
  on public.pipeline_stages
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy pipeline_stages_insert_manager
  on public.pipeline_stages
  with check (internal.can_manage_workspace(workspace_id));

alter policy pipeline_stages_update_manager
  on public.pipeline_stages
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy pipeline_stages_delete_manager
  on public.pipeline_stages
  using (internal.can_manage_workspace(workspace_id));

alter policy repository_onboarding_status_select_membership
  on public.repository_onboarding_status
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy repository_onboarding_status_manage
  on public.repository_onboarding_status
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_linear_routing_select_membership
  on public.workspace_linear_routing
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_linear_routing_manage
  on public.workspace_linear_routing
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy sandbox_capability_checks_select_membership
  on public.sandbox_capability_checks
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy sandbox_capability_checks_manage
  on public.sandbox_capability_checks
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_onboarding_select_membership
  on public.workspace_onboarding
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_onboarding_insert_managers
  on public.workspace_onboarding
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_onboarding_update_managers
  on public.workspace_onboarding
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_repository_profiles_select_membership
  on public.workspace_repository_profiles
  using (workspace_id in (select internal.current_user_workspace_ids()));

alter policy workspace_repository_profiles_insert_managers
  on public.workspace_repository_profiles
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_repository_profiles_update_managers
  on public.workspace_repository_profiles
  using (internal.can_manage_workspace(workspace_id))
  with check (internal.can_manage_workspace(workspace_id));

alter policy workspace_repository_profiles_delete_managers
  on public.workspace_repository_profiles
  using (internal.can_manage_workspace(workspace_id));

drop policy if exists agent_jobs_service_only on public.agent_jobs;
create policy agent_jobs_service_only
  on public.agent_jobs
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists workspace_secrets_service_only on public.workspace_secrets;
create policy workspace_secrets_service_only
  on public.workspace_secrets
  for all
  to authenticated
  using (false)
  with check (false);

drop policy if exists codex_device_auth_flows_service_only on public.codex_device_auth_flows;
create policy codex_device_auth_flows_service_only
  on public.codex_device_auth_flows
  for all
  to authenticated
  using (false)
  with check (false);

revoke all privileges on public.workspace_agent_config from public;
revoke all privileges on public.workspace_agent_config from anon;
revoke all privileges on public.workspace_agent_config from authenticated;
grant all privileges on public.workspace_agent_config to service_role;
grant select on public.workspace_agent_config to authenticated;
grant insert (workspace_id, key, value_json) on public.workspace_agent_config to authenticated;
grant update (key, value_json) on public.workspace_agent_config to authenticated;
grant delete on public.workspace_agent_config to authenticated;

drop function if exists public.next_session_number(uuid);

create or replace function public.next_session_number(
  target_workspace_id uuid,
  actor_user_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  allocated_number integer;
begin
  if actor_user_id is null
     or not exists (
       select 1
       from public.workspace_members wm
       where wm.workspace_id = target_workspace_id
         and wm.user_id = actor_user_id
         and wm.kind = 'human'
         and wm.is_active = true
     ) then
    raise exception 'Not authorized to allocate session numbers for workspace %', target_workspace_id
      using errcode = '42501';
  end if;

  insert into internal.workspace_issue_counters as counters (
    workspace_id,
    last_issue_number
  )
  values (target_workspace_id, 1)
  on conflict (workspace_id)
  do update
    set last_issue_number = counters.last_issue_number + 1,
        updated_at = now()
  returning last_issue_number into allocated_number;

  return allocated_number;
end;
$$;

drop function if exists public.create_workspace(text, text);

create or replace function public.create_workspace(
  actor_user_id uuid,
  workspace_name text,
  requested_slug text default null,
  actor_email text default null,
  actor_full_name text default null,
  actor_avatar_url text default null
)
returns public.workspaces
language plpgsql
security definer
set search_path = ''
as $$
declare
  base_slug text;
  candidate_slug text;
  suffix integer := 0;
  created_workspace public.workspaces%rowtype;
  profile_row public.profiles%rowtype;
  default_pipeline_id uuid;
begin
  if actor_user_id is null then
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
  where profile_record.id = actor_user_id;

  insert into public.workspaces (
    slug,
    name,
    created_by
  )
  values (
    candidate_slug,
    workspace_name,
    actor_user_id
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
    actor_user_id,
    'human',
    'owner',
    coalesce(profile_row.primary_email, nullif(actor_email, '')),
    coalesce(profile_row.full_name, nullif(actor_full_name, '')),
    coalesce(profile_row.avatar_url, nullif(actor_avatar_url, ''))
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

  insert into public.pipelines (workspace_id, name, is_default)
  values (created_workspace.id, 'Default', true)
  returning id into default_pipeline_id;

  insert into public.pipeline_stages (
    pipeline_id, workspace_id, position, slug, name, description, prompt_template_md
  )
  select
    default_pipeline_id,
    created_workspace.id,
    s.stage_position,
    s.slug,
    s.name,
    s.description,
    s.prompt_template_md
  from internal.default_pipeline_stages() s;

  insert into public.workspace_onboarding (workspace_id)
  values (created_workspace.id);

  return created_workspace;
end;
$$;

create or replace function public.rewrite_default_pipeline(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_pipeline_id uuid;
  duplicate_stage_ids uuid[];
  duplicate_stage_slugs text[];
  invalid_member_ids uuid[];
  delete_stage_ids uuid[];
  blocking_session_numbers integer[];
begin
  if coalesce(jsonb_typeof(stage_payload), '') <> 'array'
     or jsonb_array_length(stage_payload) = 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'invalid_stage_payload'
    );
  end if;

  select p.id
  into target_pipeline_id
  from public.pipelines p
  where p.workspace_id = target_workspace_id
    and p.is_default = true
  for update;

  if target_pipeline_id is null then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'pipeline_not_found'
    );
  end if;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_ids.id order by duplicate_ids.id), '{}'::uuid[])
  into duplicate_stage_ids
  from (
    select i.id
    from input_stages i
    where i.id is not null
    group by i.id
    having count(*) > 1
  ) duplicate_ids;

  if cardinality(duplicate_stage_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_id',
      'duplicate_stage_ids', to_jsonb(duplicate_stage_ids)
    );
  end if;

  with input_stages as (
    select payload.stage ->> 'slug' as slug
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(duplicate_slugs.slug order by duplicate_slugs.slug), '{}'::text[])
  into duplicate_stage_slugs
  from (
    select i.slug
    from input_stages i
    group by i.slug
    having count(*) > 1
  ) duplicate_slugs;

  if cardinality(duplicate_stage_slugs) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'duplicate_stage_slug',
      'duplicate_stage_slugs', to_jsonb(duplicate_stage_slugs)
    );
  end if;

  with input_stages as (
    select array(
      select ids.member_id::uuid
      from jsonb_array_elements_text(
        coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
      ) with ordinality as ids(member_id, member_ordinality)
      order by ids.member_ordinality
    )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(distinct ids.member_id order by ids.member_id), '{}'::uuid[])
  into invalid_member_ids
  from (
    select unnest(i.approver_member_ids) as member_id
    from input_stages i
  ) ids
  where not exists (
    select 1
    from public.workspace_members wm
    where wm.id = ids.member_id
      and wm.workspace_id = target_workspace_id
  );

  if cardinality(invalid_member_ids) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'unknown_approver_member_ids',
      'invalid_approver_member_ids', to_jsonb(invalid_member_ids)
    );
  end if;

  with input_stages as (
    select nullif(payload.stage ->> 'id', '')::uuid as id
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  select coalesce(array_agg(ps.id order by ps.position), '{}'::uuid[])
  into delete_stage_ids
  from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id
    and not exists (
      select 1
      from input_stages i
      where i.id = ps.id
    );

  select coalesce(array_agg(s.number order by s.number), '{}'::integer[])
  into blocking_session_numbers
  from public.sessions s
  where s.workspace_id = target_workspace_id
    and s.archived_at is null
    and s.current_stage_id = any(delete_stage_ids);

  if cardinality(blocking_session_numbers) > 0 then
    return jsonb_build_object(
      'ok', false,
      'error_code', 'stage_delete_blocked',
      'blocking_session_numbers', to_jsonb(blocking_session_numbers)
    );
  end if;

  set constraints
    public.pipeline_stages_pipeline_slug_unique,
    public.pipeline_stages_pipeline_position_unique
    deferred;

  update public.pipelines p
  set name = coalesce(pipeline_name, 'Default')
  where p.id = target_pipeline_id;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  update public.pipeline_stages ps
  set
    approver_member_ids = i.approver_member_ids,
    description = i.description,
    name = i.name,
    position = i.input_index,
    prompt_template_md = i.prompt_template_md,
    slug = i.slug
  from input_stages i
  where ps.id = i.id
    and ps.pipeline_id = target_pipeline_id;

  with input_stages as (
    select
      payload.ordinality::integer as input_index,
      nullif(payload.stage ->> 'id', '')::uuid as id,
      payload.stage ->> 'slug' as slug,
      payload.stage ->> 'name' as name,
      coalesce(payload.stage ->> 'description', '') as description,
      coalesce(payload.stage ->> 'promptTemplateMd', '') as prompt_template_md,
      array(
        select ids.member_id::uuid
        from jsonb_array_elements_text(
          coalesce(payload.stage -> 'approverMemberIds', '[]'::jsonb)
        ) with ordinality as ids(member_id, member_ordinality)
        order by ids.member_ordinality
      )::uuid[] as approver_member_ids
    from jsonb_array_elements(stage_payload) with ordinality as payload(stage, ordinality)
  )
  insert into public.pipeline_stages (
    pipeline_id,
    workspace_id,
    position,
    slug,
    name,
    description,
    prompt_template_md,
    approver_member_ids
  )
  select
    target_pipeline_id,
    target_workspace_id,
    i.input_index,
    i.slug,
    i.name,
    i.description,
    i.prompt_template_md,
    i.approver_member_ids
  from input_stages i
  where i.id is null
    or not exists (
      select 1
      from public.pipeline_stages ps
      where ps.id = i.id
        and ps.pipeline_id = target_pipeline_id
    );

  delete from public.pipeline_stages ps
  where ps.pipeline_id = target_pipeline_id
    and ps.id = any(delete_stage_ids);

  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.acquire_codex_auth_lease(
  target_user_id uuid,
  target_run_id uuid,
  lease_expires_at timestamptz
)
returns table (
  credential_type text,
  encrypted_credential text,
  access_token_expires_at timestamptz,
  credential_version integer,
  auth_cache_last_refresh timestamptz,
  auth_reconnect_required boolean,
  auth_reconnect_reason text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.user_codex_credentials
  set
    auth_lock_run_id = target_run_id,
    auth_lock_expires_at = lease_expires_at,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.auth_reconnect_required = false
    and (
      public.user_codex_credentials.auth_lock_run_id is null
      or public.user_codex_credentials.auth_lock_run_id = target_run_id
      or public.user_codex_credentials.auth_lock_expires_at is null
      or public.user_codex_credentials.auth_lock_expires_at <= now()
    )
  returning
    public.user_codex_credentials.credential_type,
    public.user_codex_credentials.encrypted_credential,
    public.user_codex_credentials.access_token_expires_at,
    public.user_codex_credentials.credential_version,
    public.user_codex_credentials.auth_cache_last_refresh,
    public.user_codex_credentials.auth_reconnect_required,
    public.user_codex_credentials.auth_reconnect_reason;
end;
$$;

create or replace function public.persist_codex_auth_json(
  target_user_id uuid,
  target_run_id uuid,
  previous_credential_version integer,
  new_encrypted_credential text,
  new_auth_cache_last_refresh timestamptz,
  new_account_id text,
  new_account_email text
)
returns table (
  credential_version integer
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  update public.user_codex_credentials
  set
    account_email = new_account_email,
    account_id = new_account_id,
    auth_cache_last_refresh = new_auth_cache_last_refresh,
    auth_reconnect_reason = null,
    auth_reconnect_required = false,
    credential_version = public.user_codex_credentials.credential_version + 1,
    encrypted_credential = new_encrypted_credential,
    updated_at = now()
  where public.user_codex_credentials.user_id = target_user_id
    and public.user_codex_credentials.credential_type = 'chatgpt_auth_json'
    and public.user_codex_credentials.auth_lock_run_id = target_run_id
    and public.user_codex_credentials.credential_version = previous_credential_version
  returning public.user_codex_credentials.credential_version;
end;
$$;

revoke all on function public.acquire_codex_auth_lease(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.persist_codex_auth_json(uuid, uuid, integer, text, timestamptz, text, text)
  from public, anon, authenticated;
revoke all on function public.release_codex_auth_lease(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.mark_codex_auth_reconnect_required(uuid, uuid, text)
  from public, anon, authenticated;
revoke all on function public.approve_session_stage(uuid, uuid, integer, uuid)
  from public, anon, authenticated;
revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb)
  from public, anon, authenticated;
revoke all on function public.claim_agent_job(uuid, integer)
  from public, anon, authenticated;
revoke all on function public.schedule_job_retry(uuid, integer, integer)
  from public, anon, authenticated;
revoke all on function public.create_workspace(uuid, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.next_session_number(uuid, uuid)
  from public, anon, authenticated;

grant execute on function public.acquire_codex_auth_lease(uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.persist_codex_auth_json(uuid, uuid, integer, text, timestamptz, text, text)
  to service_role;
grant execute on function public.release_codex_auth_lease(uuid, uuid)
  to service_role;
grant execute on function public.mark_codex_auth_reconnect_required(uuid, uuid, text)
  to service_role;
grant execute on function public.approve_session_stage(uuid, uuid, integer, uuid)
  to service_role;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb)
  to service_role;
grant execute on function public.claim_agent_job(uuid, integer)
  to service_role;
grant execute on function public.schedule_job_retry(uuid, integer, integer)
  to service_role;
grant execute on function public.create_workspace(uuid, text, text, text, text, text)
  to service_role;
grant execute on function public.next_session_number(uuid, uuid)
  to service_role;

drop function if exists public.current_user_workspace_ids();
drop function if exists public.can_manage_workspace(uuid);
