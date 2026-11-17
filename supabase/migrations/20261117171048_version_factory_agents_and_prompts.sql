-- Named agents own an append-only instruction history. A factory definition
-- selects an exact revision and embeds its bytes, while every execution run
-- retains the corresponding identity independently of mutable configuration.
create table public.factory_agents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$' and char_length(slug) between 1 and 60),
  is_default boolean not null default false,
  authority text not null default 'implementation' check (authority = 'implementation'),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, slug),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);
create unique index factory_agents_one_default_idx on public.factory_agents(factory_id) where is_default;

create table public.factory_agent_prompt_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  agent_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  prompt_md text not null check (char_length(prompt_md) <= 20000),
  prompt_sha256 text not null check (prompt_sha256 = encode(sha256(convert_to(prompt_md, 'UTF8')), 'hex')),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, agent_id, id),
  unique (workspace_id, agent_id, id),
  unique (agent_id, revision_number),
  foreign key (workspace_id, factory_id, agent_id)
    references public.factory_agents(workspace_id, factory_id, id) on delete cascade
);
create index factory_agent_prompt_revisions_factory_idx
  on public.factory_agent_prompt_revisions(workspace_id, factory_id, created_at desc, id desc);

alter table public.factory_agents enable row level security;
alter table public.factory_agent_prompt_revisions enable row level security;
revoke all on public.factory_agents, public.factory_agent_prompt_revisions
  from public, anon, authenticated, service_role;
grant select on public.factory_agents, public.factory_agent_prompt_revisions to authenticated, service_role;
create policy factory_agents_select on public.factory_agents for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_agent_prompt_revisions_select on public.factory_agent_prompt_revisions for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));

create function internal.preserve_factory_agent_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories where (workspace_id, id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  raise exception 'Agent identities and prompt revisions are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_agent_history() from public, anon, authenticated, service_role;
create trigger preserve_factory_agents before update or delete on public.factory_agents
  for each row execute function internal.preserve_factory_agent_history();
create trigger preserve_factory_agent_prompt_revisions before update or delete on public.factory_agent_prompt_revisions
  for each row execute function internal.preserve_factory_agent_history();

create function internal.provision_factory_implementation_agent()
returns trigger language plpgsql security definer set search_path = '' as $$
declare implementation_id uuid;
begin
  insert into public.factory_agents(workspace_id, factory_id, name, slug, is_default)
  values (new.workspace_id, new.id, 'Implementation agent', 'implementation', true)
  returning id into implementation_id;
  insert into public.factory_agent_prompt_revisions(
    workspace_id, factory_id, agent_id, revision_number, prompt_md, prompt_sha256
  ) values (new.workspace_id, new.id, implementation_id, 1, '', encode(sha256(convert_to('', 'UTF8')), 'hex'));
  return new;
end;
$$;
revoke all on function internal.provision_factory_implementation_agent() from public, anon, authenticated, service_role;
create trigger factories_provision_implementation_agent after insert on public.factories
  for each row execute function internal.provision_factory_implementation_agent();
insert into public.factory_agents(workspace_id, factory_id, name, slug, is_default)
select workspace_id, id, 'Implementation agent', 'implementation', true from public.factories;
insert into public.factory_agent_prompt_revisions(
  workspace_id, factory_id, agent_id, revision_number, prompt_md, prompt_sha256
)
select workspace_id, factory_id, id, 1, '', encode(sha256(convert_to('', 'UTF8')), 'hex')
from public.factory_agents where is_default;

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created'
));

create function public.create_factory_agent(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_name text, p_slug text, p_prompt_md text default ''
) returns public.factory_agent_prompt_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; created_agent_id uuid; result public.factory_agent_prompt_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  insert into public.factory_agents(workspace_id, factory_id, name, slug, created_by)
  values (p_workspace_id, p_factory_id, btrim(p_name), p_slug, p_actor_user_id)
  returning id into created_agent_id;
  insert into public.factory_agent_prompt_revisions(
    workspace_id, factory_id, agent_id, revision_number, prompt_md, prompt_sha256, created_by
  ) values (p_workspace_id, p_factory_id, created_agent_id, 1, p_prompt_md,
    encode(sha256(convert_to(p_prompt_md, 'UTF8')), 'hex'), p_actor_user_id)
  returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id, 'agent.created', actor_member_id,
    jsonb_build_object('agentId', created_agent_id, 'promptRevisionId', result.id, 'revisionNumber', 1));
  return result;
end;
$$;
revoke all on function public.create_factory_agent(uuid, uuid, uuid, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_agent(uuid, uuid, uuid, text, text, text) to service_role;

create function public.save_factory_agent_prompt_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_agent_id uuid, p_expected_revision_number integer, p_prompt_md text
) returns public.factory_agent_prompt_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; current_revision integer; result public.factory_agent_prompt_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  perform 1 from public.factory_agents
  where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_agent_id)
  for update;
  if not found then
    raise exception 'Agent is unavailable in this factory.' using errcode = 'P0002';
  end if;
  select max(revision_number) into current_revision from public.factory_agent_prompt_revisions
  where agent_id = p_agent_id;
  if p_expected_revision_number is distinct from current_revision then
    raise exception 'The agent prompt changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;
  insert into public.factory_agent_prompt_revisions(
    workspace_id, factory_id, agent_id, revision_number, prompt_md, prompt_sha256, created_by
  ) values (p_workspace_id, p_factory_id, p_agent_id, current_revision + 1, p_prompt_md,
    encode(sha256(convert_to(p_prompt_md, 'UTF8')), 'hex'), p_actor_user_id)
  returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (p_workspace_id, p_factory_id, 'agent.prompt_revision_created', actor_member_id,
    jsonb_build_object('agentId', p_agent_id, 'promptRevisionId', result.id, 'revisionNumber', result.revision_number));
  return result;
end;
$$;
revoke all on function public.save_factory_agent_prompt_revision(uuid, uuid, uuid, uuid, integer, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_factory_agent_prompt_revision(uuid, uuid, uuid, uuid, integer, text) to service_role;

create function internal.assert_factory_agent_snapshot(
  p_workspace_id uuid, p_factory_id uuid, p_snapshot jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
begin
  if jsonb_typeof(p_snapshot) is distinct from 'object' then
    raise exception 'The implementation agent snapshot must match a prompt revision in this factory.' using errcode = 'PT422';
  end if;
  if jsonb_typeof(p_snapshot->'agentId') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'promptRevisionId') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'promptMd') is distinct from 'string'
    or jsonb_typeof(p_snapshot->'promptSha256') is distinct from 'string'
    or p_snapshot - array['agentId', 'promptRevisionId', 'promptMd', 'promptSha256'] <> '{}'::jsonb
    or not exists (
      select 1 from public.factory_agent_prompt_revisions revision
      join public.factory_agents agent
        on (agent.workspace_id, agent.factory_id, agent.id) =
          (revision.workspace_id, revision.factory_id, revision.agent_id)
      where revision.workspace_id = p_workspace_id and revision.factory_id = p_factory_id
        and agent.authority = 'implementation'
        and agent.id::text = p_snapshot->>'agentId'
        and revision.id::text = p_snapshot->>'promptRevisionId'
        and revision.prompt_md = p_snapshot->>'promptMd'
        and revision.prompt_sha256 = p_snapshot->>'promptSha256'
    ) then
    raise exception 'The implementation agent snapshot must match a prompt revision in this factory.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_agent_snapshot(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function internal.assert_factory_agent_snapshot(uuid, uuid, jsonb) to service_role;

-- Existing stored bytes remain unchanged. A reference added to a new candidate
-- is validated again at publication, smoke reservation, and activation.
create or replace function internal.assert_factory_definition_resource_scope(
  p_workspace_id uuid, p_factory_id uuid, p_definition jsonb
) returns void language plpgsql set search_path = '' as $$
begin
  if exists (
    select 1 from public.pipelines pipeline
    where pipeline.id = (p_definition->>'pipelineId')::uuid
      and pipeline.workspace_id = p_workspace_id and pipeline.factory_id <> p_factory_id
  ) then
    raise exception 'The definition pipeline is outside the factory scope.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from public.github_repositories repository
    where repository.id = (p_definition->>'repositoryId')::uuid
      and repository.workspace_id = p_workspace_id and repository.factory_id <> p_factory_id
  ) then
    raise exception 'The definition repository is outside the factory scope.' using errcode = 'PT422';
  end if;
  if p_definition ? 'implementationAgent' then
    perform internal.assert_factory_agent_snapshot(p_workspace_id, p_factory_id, p_definition->'implementationAgent');
  end if;
end;
$$;
revoke all on function internal.assert_factory_definition_resource_scope(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

alter table public.agent_runs add column agent_id uuid default null::uuid,
  add column agent_prompt_revision_id uuid default null::uuid;
update public.agent_runs run
set agent_id = agent.id, agent_prompt_revision_id = revision.id
from public.sessions session
join public.factory_agents agent on (agent.workspace_id, agent.factory_id) = (session.workspace_id, session.factory_id)
  and agent.is_default
join public.factory_agent_prompt_revisions revision on revision.agent_id = agent.id and revision.revision_number = 1
where (run.workspace_id, run.session_id) = (session.workspace_id, session.id);
alter table public.agent_runs
  alter column agent_id set not null,
  alter column agent_prompt_revision_id set not null,
  add constraint agent_runs_agent_prompt_revision_fkey
    foreign key (workspace_id, agent_id, agent_prompt_revision_id)
      references public.factory_agent_prompt_revisions(workspace_id, agent_id, id);
create index agent_runs_agent_prompt_revision_idx on public.agent_runs(workspace_id, agent_id, agent_prompt_revision_id);

create function internal.pin_run_factory_agent()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare session_owner public.sessions; definition jsonb; snapshot jsonb;
  selected_agent_id uuid; selected_revision_id uuid;
begin
  if tg_op = 'UPDATE' then
    if (new.workspace_id, new.session_id, new.agent_id, new.agent_prompt_revision_id)
      is distinct from (old.workspace_id, old.session_id, old.agent_id, old.agent_prompt_revision_id) then
      raise exception 'Run agent identity and prompt revision are immutable.' using errcode = '23514';
    end if;
    return new;
  end if;
  select * into session_owner from public.sessions
  where (workspace_id, id) = (new.workspace_id, new.session_id);
  if not found then
    raise exception 'Run session is unavailable.' using errcode = '23514';
  end if;
  definition := internal.pinned_session_execution_definition(session_owner);
  if definition ? 'implementationAgent' then
    snapshot := definition->'implementationAgent';
    perform internal.assert_factory_agent_snapshot(new.workspace_id, session_owner.factory_id, snapshot);
    selected_agent_id := (snapshot->>'agentId')::uuid;
    selected_revision_id := (snapshot->>'promptRevisionId')::uuid;
  else
    select agent.id, revision.id into selected_agent_id, selected_revision_id
    from public.factory_agents agent
    join public.factory_agent_prompt_revisions revision on revision.agent_id = agent.id and revision.revision_number = 1
    where (agent.workspace_id, agent.factory_id) = (new.workspace_id, session_owner.factory_id) and agent.is_default;
  end if;
  if selected_agent_id is null or selected_revision_id is null
    or (new.agent_id is not null and new.agent_id <> selected_agent_id)
    or (new.agent_prompt_revision_id is not null and new.agent_prompt_revision_id <> selected_revision_id) then
    raise exception 'Run agent must match the session implementation agent revision.' using errcode = '23514';
  end if;
  new.agent_id := selected_agent_id;
  new.agent_prompt_revision_id := selected_revision_id;
  return new;
end;
$$;
revoke all on function internal.pin_run_factory_agent() from public, anon, authenticated, service_role;
create trigger pin_run_factory_agent before insert or update of workspace_id, session_id, agent_id, agent_prompt_revision_id on public.agent_runs
  for each row execute function internal.pin_run_factory_agent();
