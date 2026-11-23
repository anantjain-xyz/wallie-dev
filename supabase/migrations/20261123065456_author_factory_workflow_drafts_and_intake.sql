-- Scratch overlay. The graph registration and base definition history stay
-- the existing immutable execution contracts. Authoring adds versioned heads.
create table internal.factory_workflow_authoring_workflows (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  display_name text not null check (display_name=btrim(display_name) and char_length(display_name) between 1 and 120),
  created_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id,factory_id,id),
  foreign key (workspace_id,factory_id) references public.factories(workspace_id,id) on delete cascade
);

create table internal.factory_workflow_authoring_drafts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  workflow_id uuid not null,
  revision_number bigint not null check (revision_number between 1 and 9007199254740991),
  previous_draft_id uuid,
  prior_activation_id uuid,
  request_id uuid not null,
  base_activation_id uuid not null references public.factory_definition_activations(id) deferrable initially deferred,
  base_activation_number bigint not null check (base_activation_number > 0),
  base_definition_revision_id uuid not null,
  base_definition_digest text not null check (base_definition_digest collate "C" ~ '^[a-f0-9]{64}$'),
  workflow_json text not null check (workflow_json is json object with unique keys),
  workflow_digest text not null check (workflow_digest=encode(sha256(convert_to(workflow_json,'UTF8')),'hex')),
  created_by_member_id uuid not null,
  explicitly_rebased boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  unique (workflow_id,revision_number),
  unique (workflow_id,request_id),
  unique (workflow_id,id),
  foreign key (workspace_id,factory_id,workflow_id)
    references internal.factory_workflow_authoring_workflows(workspace_id,factory_id,id) on delete cascade,
  foreign key (workflow_id,previous_draft_id)
    references internal.factory_workflow_authoring_drafts(workflow_id,id) deferrable initially deferred,
  foreign key (workspace_id,factory_id,base_activation_number)
    references public.factory_definition_activations(workspace_id,factory_id,activation_number) deferrable initially deferred
);

create table internal.factory_workflow_authoring_activations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  workflow_id uuid not null,
  activation_number bigint not null check (activation_number between 1 and 9007199254740991),
  previous_activation_id uuid,
  draft_id uuid not null,
  base_activation_id uuid not null references public.factory_definition_activations(id) deferrable initially deferred,
  base_activation_number bigint not null check (base_activation_number > 0),
  base_definition_revision_id uuid not null,
  base_definition_digest text not null,
  graph_revision_id uuid not null,
  workflow_digest text not null,
  request_id uuid not null,
  published_by_member_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  unique (workflow_id,activation_number),
  unique (workflow_id,request_id),
  unique (workflow_id,draft_id),
  unique (workflow_id,id),
  foreign key (workspace_id,factory_id,workflow_id)
    references internal.factory_workflow_authoring_workflows(workspace_id,factory_id,id) on delete cascade,
  foreign key (workflow_id,draft_id)
    references internal.factory_workflow_authoring_drafts(workflow_id,id) on delete cascade,
  foreign key (workflow_id,previous_activation_id)
    references internal.factory_workflow_authoring_activations(workflow_id,id) deferrable initially deferred,
  foreign key (workspace_id,factory_id,base_definition_revision_id,base_definition_digest,graph_revision_id,workflow_digest)
    references internal.factory_workflow_graph_revisions(workspace_id,factory_id,definition_revision_id,definition_digest,id,workflow_digest)
);

alter table internal.factory_workflow_authoring_drafts add foreign key (workflow_id,prior_activation_id)
  references internal.factory_workflow_authoring_activations(workflow_id,id) deferrable initially deferred;
alter table internal.factory_workflow_authoring_workflows enable row level security;
alter table internal.factory_workflow_authoring_drafts enable row level security;
alter table internal.factory_workflow_authoring_activations enable row level security;
revoke all on table internal.factory_workflow_authoring_workflows,internal.factory_workflow_authoring_drafts,
  internal.factory_workflow_authoring_activations from public,anon,authenticated,service_role;
create trigger preserve_factory_workflow_authoring_drafts before update or delete on internal.factory_workflow_authoring_drafts
  for each row execute function internal.preserve_factory_definition_history();
create trigger preserve_factory_workflow_authoring_activations before update or delete on internal.factory_workflow_authoring_activations
  for each row execute function internal.preserve_factory_definition_history();

create function internal.factory_workflow_authoring_base(p_workspace_id uuid,p_factory_id uuid)
returns table(id uuid,activation_number bigint,revision_id uuid,digest text,definition jsonb)
language sql stable set search_path='' as $$
  select activation.id,activation.activation_number,revision.id,revision.canonical_digest,revision.definition_json::jsonb
  from public.factory_definition_activations activation
  join public.factory_definition_revisions revision on (revision.workspace_id,revision.factory_id,revision.id)=
    (activation.workspace_id,activation.factory_id,activation.revision_id)
  where (activation.workspace_id,activation.factory_id)=(p_workspace_id,p_factory_id)
  order by activation.activation_number desc limit 1
$$;

create function internal.lock_factory_workflow_authoring_head(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_workflow_id uuid
) returns uuid language plpgsql set search_path='' as $$
declare actor uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  perform 1 from internal.factory_workflow_authoring_workflows
  where (workspace_id,factory_id,id)=(p_workspace_id,p_factory_id,p_workflow_id) for update;
  if not found then raise exception 'Workflow is unavailable.' using errcode='P0002'; end if;
  return actor;
end;
$$;

create function internal.assert_factory_workflow_authoring_references(
  p_workspace_id uuid,p_factory_id uuid,p_base jsonb,p_plan jsonb
) returns void language plpgsql set search_path='' as $$
declare
  refs text[];
  matched integer;
  base_grant public.factory_execution_grants;
  profile_grant public.factory_execution_grants;
  profile_ref jsonb;
  profile jsonb;
begin
  select array_agg(distinct case when node->>'kind' = 'review' then node->>'reviewerPromptRevisionId'
    else node->>'agentPromptRevisionId' end) into refs
  from jsonb_array_elements(p_plan->'nodes') node
  where node->>'kind' = 'review' or node ? 'agentPromptRevisionId';
  if refs is not null then
    select count(*) into matched from (
      select prompt.id from public.factory_agent_prompt_revisions prompt
      where (prompt.workspace_id,prompt.factory_id)=(p_workspace_id,p_factory_id) and prompt.id::text=any(refs)
      order by prompt.id for share nowait
    ) scoped;
    if matched<>cardinality(refs) then raise exception 'Workflow agent prompts are unavailable.' using errcode='PT422'; end if;
  end if;

  select array_agg(distinct member.value) into refs
  from jsonb_array_elements(p_plan->'nodes') node
  cross join lateral jsonb_array_elements_text(node->'approverMemberIds') member(value)
  where node->>'kind'='human-gate';
  if refs is not null then
    select count(*) into matched from (
      select member.id from public.workspace_members member where member.workspace_id=p_workspace_id
        and member.id::text=any(refs) and member.kind='human' and member.is_active order by member.id for share nowait
    ) scoped;
    if matched<>cardinality(refs) then raise exception 'Workflow approvers are unavailable.' using errcode='PT422'; end if;
  end if;

  if p_base ? 'executionGrant' then
    base_grant:=internal.resolve_definition_execution_grant(p_workspace_id,p_factory_id,p_base,
      (p_base->>'repositoryId')::uuid,(p_base->>'executionPolicyRevisionId')::uuid);
  end if;
  -- The existing single writer runtime accepts only the base grant. OP653 can
  -- authorize an additional declared writer through its separate exact policy.
  if exists (select 1 from jsonb_array_elements(p_plan->'grants') referenced
    where (referenced->>'id',referenced->>'version') is distinct from (base_grant.id::text,base_grant.version::text))
    or exists (select 1 from jsonb_array_elements(p_plan->'nodes') node
      where node ? 'grantId' and not exists (select 1 from jsonb_array_elements(p_plan->'grants') referenced
        where referenced->>'id'=node->>'grantId'))
    then raise exception 'Workflow grant does not match the base definition.' using errcode='PT422'; end if;

  for profile_ref in
    select selected.value from jsonb_each(coalesce(p_plan#>'{delegationPolicy,targets}','{}'::jsonb)) selected
    union
    select selected.value->'foremanProfile' from jsonb_each(coalesce(p_plan#>'{routePolicy,nodes}','{}'::jsonb)) selected
    where selected.value ? 'foremanProfile'
  loop
    select definition_json::jsonb into profile from public.factory_definition_revisions
    where (workspace_id,factory_id,id::text,canonical_digest)=
      (p_workspace_id,p_factory_id,profile_ref->>'definitionRevisionId',profile_ref->>'definitionDigest');
    if not found then raise exception 'Workflow execution profile is unavailable.' using errcode='PT422'; end if;
    profile_grant:=internal.resolve_definition_execution_grant(p_workspace_id,p_factory_id,profile,
      (profile->>'repositoryId')::uuid,(profile->>'executionPolicyRevisionId')::uuid);
    if profile_grant.id is null or base_grant.id is null
      or (profile_grant.service_principal_id,profile_grant.budget_payer_member_id,profile_grant.execution_policy_revision_id,
        profile_grant.github_repository_id) is distinct from (base_grant.service_principal_id,base_grant.budget_payer_member_id,
        base_grant.execution_policy_revision_id,base_grant.github_repository_id)
      then raise exception 'Workflow execution profile exceeds the base authority.' using errcode='PT422'; end if;
  end loop;
exception when lock_not_available then
  raise exception 'Workflow reference access is changing. Retry shortly.' using errcode='PT409';
end;
$$;

create function internal.validate_factory_workflow_authoring_payload(p_json text,p_digest text)
returns jsonb language plpgsql set search_path='' as $$
declare plan jsonb;
begin
  if p_json is null or octet_length(p_json)>262144 or not (p_json is json object with unique keys)
    or p_digest is distinct from encode(sha256(convert_to(p_json,'UTF8')),'hex')
    then raise exception 'Verified compiled workflow JSON is required.' using errcode='22023'; end if;
  plan:=p_json::jsonb;
  if plan->'schemaVersion' is distinct from '1'::jsonb or plan->>'kind' is distinct from 'graph'
    or jsonb_typeof(plan->'nodes') is distinct from 'array' or jsonb_array_length(plan->'nodes') not between 1 and 128
    or jsonb_typeof(plan->'edges') is distinct from 'array' or jsonb_array_length(plan->'edges')>512
    or jsonb_typeof(plan->'grants') is distinct from 'array' or jsonb_array_length(plan->'grants')>128
    or (select count(*) from jsonb_array_elements(plan->'nodes') node where node->>'id'=plan->>'entryNodeId')<>1
    then raise exception 'A compiled version 1 workflow graph is required.' using errcode='22023'; end if;
  return plan;
end;
$$;

create function public.create_factory_workflow_authoring(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_workflow_id uuid,p_display_name text
) returns uuid language plpgsql security definer set search_path='' as $$
declare actor uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor:=internal.assert_factory_manager(p_workspace_id,p_factory_id,p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id,p_factory_id);
  insert into internal.factory_workflow_authoring_workflows(id,workspace_id,factory_id,display_name,created_by_member_id)
  values(p_workflow_id,p_workspace_id,p_factory_id,btrim(p_display_name),actor) on conflict(id) do nothing;
  if exists(select 1 from internal.factory_workflow_authoring_workflows
    where (id,workspace_id,factory_id,display_name,created_by_member_id)=(p_workflow_id,p_workspace_id,p_factory_id,btrim(p_display_name),actor))
    then return p_workflow_id; end if;
  raise exception 'Workflow identity is unavailable.' using errcode='PT409';
end;
$$;

create function public.read_factory_workflow_authoring(
  p_workspace_id uuid,p_factory_id uuid,p_workflow_id uuid,p_selected_draft_id uuid default null
) returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('workflowId',workflow.id,'displayName',workflow.display_name,
    'baseDefinition',jsonb_build_object('activationId',base.id,'revisionId',base.revision_id,'digest',base.digest),
    'draftId',draft.id,'activationId',published.id,'draftDigest',draft.workflow_digest,'publishedDraftId',published.draft_id,
    'draftBaseDefinition',case when draft.id is not null then jsonb_build_object('activationId',draft.base_activation_id,
      'revisionId',draft.base_definition_revision_id,'digest',draft.base_definition_digest) end,
    'graph',draft.workflow_json::jsonb,'selectedDraftId',selected.id,
    'selectedDraftGraph',selected.workflow_json::jsonb,'selectedDraftDigest',selected.workflow_digest,
    'selectedDraftBaseDefinition',case when selected.id is not null then jsonb_build_object('activationId',selected.base_activation_id,
      'revisionId',selected.base_definition_revision_id,'digest',selected.base_definition_digest) end,
    'publishedGraphRevisionId',published.graph_revision_id,'recentDrafts',history.drafts)
  from internal.factory_workflow_authoring_workflows workflow
  join public.factories factory on (factory.workspace_id,factory.id)=(workflow.workspace_id,workflow.factory_id)
  left join lateral internal.factory_workflow_authoring_base(workflow.workspace_id,workflow.factory_id) base on true
  left join lateral (select * from internal.factory_workflow_authoring_drafts candidate
    where candidate.workflow_id=workflow.id order by revision_number desc limit 1) draft on true
  left join lateral (select * from internal.factory_workflow_authoring_activations candidate
    where candidate.workflow_id=workflow.id order by activation_number desc limit 1) published on true
  left join internal.factory_workflow_authoring_drafts selected on (selected.workflow_id,selected.id)=(workflow.id,p_selected_draft_id)
  cross join lateral (
    select coalesce(jsonb_agg(jsonb_build_object('id',candidate.id,'revision',candidate.revision_number)
      order by candidate.revision_number desc),'[]'::jsonb) as drafts
    from (select id,revision_number from internal.factory_workflow_authoring_drafts
      where workflow_id=workflow.id order by revision_number desc limit 20) candidate
  ) history
  where (workflow.workspace_id,workflow.factory_id,workflow.id)=(p_workspace_id,p_factory_id,p_workflow_id)
    and factory.status='active' and auth.uid() is not null and internal.can_manage_factory(p_workspace_id,p_factory_id)
    and (p_selected_draft_id is null or selected.id is not null)
$$;

create function public.save_factory_workflow_authoring_draft(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_workflow_id uuid,p_request_id uuid,
  p_expected_base_activation_id uuid,p_expected_base_revision_id uuid,p_expected_base_digest text,
  p_workflow_json text,p_workflow_digest text,p_expected_draft_id uuid default null,
  p_expected_activation_id uuid default null,p_rebase boolean default false
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  previous internal.factory_workflow_authoring_drafts;
  prior_activation internal.factory_workflow_authoring_activations;
  saved internal.factory_workflow_authoring_drafts;
  base record;
  plan jsonb;
begin
  actor:=internal.lock_factory_workflow_authoring_head(p_workspace_id,p_factory_id,p_actor_user_id,p_workflow_id);
  if p_request_id is null or p_rebase is null then raise exception 'A workflow save request is required.' using errcode='22023'; end if;
  plan:=internal.validate_factory_workflow_authoring_payload(p_workflow_json,p_workflow_digest);
  select * into saved from internal.factory_workflow_authoring_drafts where workflow_id=p_workflow_id and request_id=p_request_id;
  if found then
    if (saved.created_by_member_id,saved.previous_draft_id,saved.prior_activation_id,saved.base_activation_id,
      saved.base_definition_revision_id,saved.base_definition_digest,saved.workflow_digest,saved.workflow_json,saved.explicitly_rebased)
      is distinct from (actor,p_expected_draft_id,p_expected_activation_id,p_expected_base_activation_id,p_expected_base_revision_id,
        p_expected_base_digest,p_workflow_digest,p_workflow_json,p_rebase)
      then raise exception 'Workflow save request already identifies a different change.' using errcode='PT409'; end if;
    return jsonb_build_object('draftId',saved.id,'digest',saved.workflow_digest,'created',false);
  end if;

  select * into base from internal.factory_workflow_authoring_base(p_workspace_id,p_factory_id);
  if not found or (base.id,base.revision_id,base.digest) is distinct from
    (p_expected_base_activation_id,p_expected_base_revision_id,p_expected_base_digest)
    then raise exception 'The active base definition changed.' using errcode='PT409'; end if;
  select * into previous from internal.factory_workflow_authoring_drafts
  where workflow_id=p_workflow_id order by revision_number desc limit 1;
  select * into prior_activation from internal.factory_workflow_authoring_activations
  where workflow_id=p_workflow_id order by activation_number desc limit 1;
  if (previous.id,prior_activation.id) is distinct from (p_expected_draft_id,p_expected_activation_id)
    then raise exception 'The workflow draft or published activation changed.' using errcode='PT409'; end if;
  if (previous.id is not null and previous.base_activation_id<>base.id) is distinct from p_rebase
    then raise exception 'An explicit rebase is required for the changed base definition.' using errcode='PT409'; end if;

  perform internal.assert_factory_workflow_authoring_references(p_workspace_id,p_factory_id,base.definition,plan);
  insert into internal.factory_workflow_authoring_drafts(workspace_id,factory_id,workflow_id,revision_number,
    previous_draft_id,prior_activation_id,request_id,base_activation_id,base_activation_number,base_definition_revision_id,
    base_definition_digest,workflow_json,workflow_digest,created_by_member_id,explicitly_rebased)
  values(p_workspace_id,p_factory_id,p_workflow_id,coalesce(previous.revision_number,0)+1,previous.id,prior_activation.id,
    p_request_id,base.id,base.activation_number,base.revision_id,base.digest,p_workflow_json,p_workflow_digest,actor,p_rebase)
  returning * into saved;
  return jsonb_build_object('draftId',saved.id,'digest',saved.workflow_digest,'created',true);
end;
$$;

create function public.publish_factory_workflow_authoring_draft(
  p_workspace_id uuid,p_factory_id uuid,p_actor_user_id uuid,p_workflow_id uuid,p_request_id uuid,
  p_expected_draft_id uuid,p_expected_base_activation_id uuid,p_expected_base_revision_id uuid,
  p_expected_base_digest text,p_verified_draft_digest text,p_expected_activation_id uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare
  actor uuid;
  draft internal.factory_workflow_authoring_drafts;
  prior internal.factory_workflow_authoring_activations;
  published internal.factory_workflow_authoring_activations;
  base record;
  graph record;
  plan jsonb;
begin
  actor:=internal.lock_factory_workflow_authoring_head(p_workspace_id,p_factory_id,p_actor_user_id,p_workflow_id);
  if p_request_id is null or p_expected_draft_id is null then
    raise exception 'Select the exact workflow draft to publish.' using errcode='22023'; end if;
  select * into published from internal.factory_workflow_authoring_activations
  where workflow_id=p_workflow_id and request_id=p_request_id;
  if found then
    if (published.published_by_member_id,published.draft_id,published.previous_activation_id,published.base_activation_id,
      published.base_definition_revision_id,published.base_definition_digest,published.workflow_digest) is distinct from
      (actor,p_expected_draft_id,p_expected_activation_id,p_expected_base_activation_id,p_expected_base_revision_id,
        p_expected_base_digest,p_verified_draft_digest)
      then raise exception 'Workflow publish request already identifies a different change.' using errcode='PT409'; end if;
    return jsonb_build_object('activationId',published.id,'draftId',published.draft_id,'graphRevisionId',published.graph_revision_id,
      'digest',published.workflow_digest,'created',false);
  end if;

  select * into base from internal.factory_workflow_authoring_base(p_workspace_id,p_factory_id);
  if not found or (base.id,base.revision_id,base.digest) is distinct from
    (p_expected_base_activation_id,p_expected_base_revision_id,p_expected_base_digest)
    then raise exception 'The active base definition changed.' using errcode='PT409'; end if;
  select * into draft from internal.factory_workflow_authoring_drafts
  where workflow_id=p_workflow_id order by revision_number desc limit 1;
  select * into prior from internal.factory_workflow_authoring_activations
  where workflow_id=p_workflow_id order by activation_number desc limit 1;
  if (draft.id,prior.id) is distinct from (p_expected_draft_id,p_expected_activation_id) or prior.draft_id=draft.id
    then raise exception 'The workflow draft or published activation changed.' using errcode='PT409'; end if;
  if (draft.base_activation_id,draft.base_definition_revision_id,draft.base_definition_digest) is distinct from
    (base.id,base.revision_id,base.digest)
    then raise exception 'The workflow draft requires a rebase before publication.' using errcode='PT409'; end if;
  if draft.workflow_digest is distinct from p_verified_draft_digest
    then raise exception 'The recompiled workflow does not match the saved draft.' using errcode='PT409'; end if;

  plan:=internal.validate_factory_workflow_authoring_payload(draft.workflow_json,draft.workflow_digest);
  perform internal.assert_factory_workflow_authoring_references(p_workspace_id,p_factory_id,base.definition,plan);
  if not internal.is_enrollable_factory_workflow_review(p_workspace_id,p_factory_id,plan) then
    raise exception 'The review requires its scoped prompt, declared rules, and exact joined input.' using errcode='PT422';
  end if;
  if exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind'='branch') then
    if not internal.is_bounded_factory_workflow_branch_graph(plan) then
      raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode='PT422'; end if;
  elsif exists (select 1 from jsonb_array_elements(plan->'nodes') node where node->>'kind'='route') then
    if not internal.is_bounded_factory_workflow_route_graph(plan) then
      raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode='PT422'; end if;
  elsif not internal.is_bounded_factory_workflow_next_path(plan) then
    raise exception 'The graph requires workflow capabilities that are unavailable.' using errcode='PT422';
  end if;
  select * into strict graph from public.register_factory_workflow_graph_revision(p_workspace_id,p_factory_id,
    base.revision_id,base.digest,draft.workflow_json,draft.workflow_digest);
  insert into internal.factory_workflow_authoring_activations(workspace_id,factory_id,workflow_id,activation_number,
    previous_activation_id,draft_id,base_activation_id,base_activation_number,base_definition_revision_id,base_definition_digest,
    graph_revision_id,workflow_digest,request_id,published_by_member_id)
  values(p_workspace_id,p_factory_id,p_workflow_id,coalesce(prior.activation_number,0)+1,prior.id,draft.id,base.id,
    base.activation_number,base.revision_id,base.digest,graph.graph_revision_id,draft.workflow_digest,p_request_id,actor)
  returning * into published;
  return jsonb_build_object('activationId',published.id,'draftId',published.draft_id,'graphRevisionId',published.graph_revision_id,
    'digest',published.workflow_digest,'created',true);
end;
$$;

create table internal.factory_workflow_authoring_session_pins (
  workspace_id uuid not null,
  factory_id uuid not null,
  session_id uuid primary key,
  workflow_id uuid not null,
  activation_id uuid not null,
  graph_revision_id uuid not null,
  workflow_digest text not null,
  foreign key (session_id,workspace_id,factory_id) references public.sessions(id,workspace_id,factory_id) on delete cascade,
  foreign key (workflow_id,activation_id) references internal.factory_workflow_authoring_activations(workflow_id,id)
);
alter table internal.factory_workflow_authoring_session_pins enable row level security;
revoke all on table internal.factory_workflow_authoring_session_pins from public,anon,authenticated,service_role;
create trigger preserve_factory_workflow_authoring_session_pin before update or delete on internal.factory_workflow_authoring_session_pins
  for each row execute function internal.guard_session_factory_admission_inputs();

-- Integrate only at new source-neutral admission. There is no public endpoint
-- to retroactively bind an existing serial session to a workflow graph.
create function internal.pin_factory_workflow_authoring_session(
  p_workspace_id uuid,p_factory_id uuid,p_session_id uuid,p_workflow_id uuid,p_activation_id uuid
) returns uuid language plpgsql set search_path='' as $$
declare
  admitted public.session_factory_admission_inputs;
  activation internal.factory_workflow_authoring_activations;
  prior internal.factory_workflow_authoring_session_pins;
  base record;
begin
  perform internal.lock_factory_workflow_root(p_session_id,p_workspace_id,p_factory_id);
  select * into prior from internal.factory_workflow_authoring_session_pins
  where (workspace_id,factory_id,session_id)=(p_workspace_id,p_factory_id,p_session_id);
  if found then
    if (prior.workflow_id,prior.activation_id) is distinct from (p_workflow_id,p_activation_id)
      then raise exception 'The session already selected a different workflow activation.' using errcode='PT409'; end if;
    return prior.graph_revision_id;
  end if;
  if exists(select 1 from internal.factory_workflow_executions where root_session_id=p_session_id)
    then raise exception 'The session has already begun a workflow.' using errcode='PT409'; end if;

  select * into activation from internal.factory_workflow_authoring_activations
  where (workspace_id,factory_id,workflow_id)=(p_workspace_id,p_factory_id,p_workflow_id)
  order by activation_number desc limit 1;
  select * into admitted from public.session_factory_admission_inputs
  where (workspace_id,factory_id,session_id)=(p_workspace_id,p_factory_id,p_session_id);
  select * into base from internal.factory_workflow_authoring_base(p_workspace_id,p_factory_id);
  if p_activation_id is null or activation.id is distinct from p_activation_id or activation.base_activation_id is distinct from base.id
    or admitted.session_id is null
    or (activation.base_activation_number,activation.base_definition_revision_id,activation.base_definition_digest) is distinct from
      (admitted.activation_number,admitted.definition_revision_id,admitted.definition_digest)
    then raise exception 'The selected workflow activation does not match the admitted definition.' using errcode='PT409'; end if;
  insert into internal.factory_workflow_authoring_session_pins(workspace_id,factory_id,session_id,workflow_id,activation_id,
    graph_revision_id,workflow_digest)
  values(p_workspace_id,p_factory_id,p_session_id,p_workflow_id,p_activation_id,activation.graph_revision_id,activation.workflow_digest);
  return activation.graph_revision_id;
end;
$$;

revoke all on function internal.factory_workflow_authoring_base(uuid,uuid),internal.lock_factory_workflow_authoring_head(uuid,uuid,uuid,uuid),
  internal.assert_factory_workflow_authoring_references(uuid,uuid,jsonb,jsonb),internal.validate_factory_workflow_authoring_payload(text,text),
  internal.pin_factory_workflow_authoring_session(uuid,uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
revoke all on function public.create_factory_workflow_authoring(uuid,uuid,uuid,uuid,text),
  public.save_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,boolean),
  public.publish_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid),
  public.read_factory_workflow_authoring(uuid,uuid,uuid,uuid)
from public,anon,authenticated,service_role;
grant execute on function public.create_factory_workflow_authoring(uuid,uuid,uuid,uuid,text),
  public.save_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,uuid,uuid,boolean),
  public.publish_factory_workflow_authoring_draft(uuid,uuid,uuid,uuid,uuid,uuid,uuid,uuid,text,text,uuid)
to service_role;
grant execute on function public.read_factory_workflow_authoring(uuid,uuid,uuid,uuid) to authenticated;

-- Runtime entry points retain their existing capability and policy checks.
-- When source-neutral admission selected a published authoring activation, all
-- runtime paths must use that immutable graph identity.
create function internal.guard_factory_workflow_authoring_execution()
returns trigger language plpgsql set search_path='' as $$
declare pin internal.factory_workflow_authoring_session_pins;
begin
  select * into pin from internal.factory_workflow_authoring_session_pins
  where session_id=new.root_session_id;
  if found and (new.workspace_id,new.factory_id,new.graph_revision_id,new.workflow_digest) is distinct from
    (pin.workspace_id,pin.factory_id,pin.graph_revision_id,pin.workflow_digest)
    then raise exception 'Execution must use the graph selected at session admission.' using errcode='PT409'; end if;
  return new;
end;
$$;
revoke all on function internal.guard_factory_workflow_authoring_execution() from public,anon,authenticated,service_role;
create trigger guard_factory_workflow_authoring_execution
  before insert or update of graph_revision_id,workflow_digest on internal.factory_workflow_executions
  for each row execute function internal.guard_factory_workflow_authoring_execution();

-- Scope the configuration index to active human factory managers.
create function public.list_factory_workflow_authoring(
  p_workspace_id uuid, p_factory_id uuid, p_after_id uuid default null
) returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('workflows', coalesce((
    select jsonb_agg(jsonb_build_object(
      'workflowId', workflow.id, 'displayName', workflow.display_name,
      'draftId', draft.id, 'publishedDraftId', published.draft_id,
      'activationId', published.id
    ) order by workflow.id)
    from (
      select * from internal.factory_workflow_authoring_workflows candidate
      where (candidate.workspace_id, candidate.factory_id) = (p_workspace_id, p_factory_id)
        and (p_after_id is null or candidate.id > p_after_id)
      order by candidate.id limit 51
    ) workflow
    left join lateral (select revision.id from internal.factory_workflow_authoring_drafts revision
      where revision.workflow_id = workflow.id order by revision.revision_number desc limit 1) draft on true
    left join lateral (select activation.id, activation.draft_id from internal.factory_workflow_authoring_activations activation
      where activation.workflow_id = workflow.id order by activation.activation_number desc limit 1) published on true
  ), '[]'::jsonb))
  from public.factories factory
  where (factory.workspace_id, factory.id, factory.status) = (p_workspace_id, p_factory_id, 'active')
    and auth.uid() is not null and internal.can_manage_factory(p_workspace_id, p_factory_id)
$$;
revoke all on function public.list_factory_workflow_authoring(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.list_factory_workflow_authoring(uuid, uuid, uuid) to authenticated;

-- Keep an optional selection as part of source-neutral intent. Omission does
-- not alter existing serial or triage request hashes and receipts.
create function internal.normalize_factory_workflow_intake_selection(p_selection jsonb)
returns jsonb language plpgsql immutable strict set search_path = '' as $$
begin
  if jsonb_typeof(p_selection) is distinct from 'object'
    or p_selection - 'workflowId' - 'activationId' <> '{}'::jsonb
    or jsonb_typeof(p_selection->'workflowId') is distinct from 'string'
    or jsonb_typeof(p_selection->'activationId') is distinct from 'string'
    or not pg_input_is_valid(p_selection->>'workflowId', 'uuid')
    or not pg_input_is_valid(p_selection->>'activationId', 'uuid') then
    raise exception 'Select an exact published workflow activation.' using errcode = '22023';
  end if;
  return jsonb_build_object('workflowId', (p_selection->>'workflowId')::uuid,
    'activationId', (p_selection->>'activationId')::uuid);
end;
$$;

create function internal.bind_factory_workflow_intake_selection(
  p_workspace_id uuid, p_factory_id uuid, p_session_id uuid, p_selection jsonb
) returns void language plpgsql strict set search_path = '' as $$
begin
  perform internal.pin_factory_workflow_authoring_session(p_workspace_id, p_factory_id, p_session_id,
    (p_selection->>'workflowId')::uuid, (p_selection->>'activationId')::uuid);
end;
$$;

revoke all on function internal.normalize_factory_workflow_intake_selection(jsonb),
  internal.bind_factory_workflow_intake_selection(uuid,uuid,uuid,jsonb)
  from public,anon,authenticated,service_role;

create or replace function internal.normalize_factory_session_mutation(
  p_operation public.factory_session_mutation_operation, p_payload jsonb
) returns jsonb language plpgsql immutable set search_path = '' as $$
declare intent jsonb; keys text[]; text_fields text[];
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or p_operation is null then
    raise exception 'Invalid session mutation intent.' using errcode = '22023';
  end if;
  case p_operation
    when 'create' then
      keys := array['title', 'prompt', 'agentId', 'repositoryId', 'draftSpecification', 'workflowSelection'];
      text_fields := array['title', 'prompt', 'agentId', 'repositoryId'];
      if (p_payload ? 'draftSpecification' and jsonb_typeof(p_payload->'draftSpecification') <> 'boolean')
        or length(btrim(p_payload->>'title', E' \t\r\n')) not between 1 and 200
        or length(btrim(p_payload->>'prompt', E' \t\r\n')) not between 1 and 20000 then
        raise exception 'Invalid session creation intent.' using errcode = '22023';
      end if;
      intent := jsonb_build_object(
        'title', btrim(p_payload->>'title', E' \t\r\n'), 'prompt', btrim(p_payload->>'prompt', E' \t\r\n'),
        'agentId', (p_payload->>'agentId')::uuid, 'repositoryId', (p_payload->>'repositoryId')::uuid,
        'draftSpecification', coalesce((p_payload->>'draftSpecification')::boolean, false));
      if p_payload ? 'workflowSelection' then
        if (intent->>'draftSpecification')::boolean then
          raise exception 'Select a published workflow or draft a specification.' using errcode = '22023';
        end if;
        intent := intent || jsonb_build_object('workflowSelection',
          internal.normalize_factory_workflow_intake_selection(p_payload->'workflowSelection'));
      end if;
    when 'follow_up', 'answer_clarification' then
      keys := array['sessionId', 'artifactId', 'artifactVersion', 'reviewRevision'];
      text_fields := array['sessionId', 'artifactId'];
      if jsonb_typeof(p_payload->'artifactVersion') is distinct from 'number'
        or jsonb_typeof(p_payload->'reviewRevision') is distinct from 'number'
        or (p_payload->>'artifactVersion')::integer < 1 or (p_payload->>'reviewRevision')::bigint < 0 then
        raise exception 'An exact artifact version and review revision are required.' using errcode = '22023';
      end if;
      intent := jsonb_build_object(
        'sessionId', (p_payload->>'sessionId')::uuid, 'artifactId', (p_payload->>'artifactId')::uuid,
        'artifactVersion', (p_payload->>'artifactVersion')::integer,
        'reviewRevision', (p_payload->>'reviewRevision')::bigint);
      if p_operation = 'follow_up' then
        keys := keys || array['stageId', 'feedback'];
        text_fields := text_fields || array['stageId', 'feedback'];
        if length(btrim(p_payload->>'feedback', E' \t\r\n')) not between 1 and 4000 then
          raise exception 'Invalid follow-up feedback.' using errcode = '22023';
        end if;
        intent := intent || jsonb_build_object(
          'stageId', (p_payload->>'stageId')::uuid, 'feedback', btrim(p_payload->>'feedback', E' \t\r\n'));
      else
        keys := keys || array['clarificationId', 'answer'];
        text_fields := text_fields || array['clarificationId', 'answer'];
        if length(btrim(p_payload->>'answer', E' \t\r\n')) not between 1 and 2000 then
          raise exception 'Invalid clarification answer.' using errcode = '22023';
        end if;
        intent := intent || jsonb_build_object('clarificationId', (p_payload->>'clarificationId')::uuid,
          'answer', btrim(p_payload->>'answer', E' \t\r\n'));
      end if;
    when 'cancel' then
      keys := array['sessionId', 'expectedRunId'];
      text_fields := keys;
      intent := jsonb_build_object(
        'sessionId', (p_payload->>'sessionId')::uuid, 'expectedRunId', (p_payload->>'expectedRunId')::uuid);
  end case;
  if p_payload - keys <> '{}'::jsonb
    or exists (select 1 from unnest(text_fields) field where jsonb_typeof(p_payload->field) is distinct from 'string')
    or exists (select 1 from jsonb_each(intent) field where field.value = 'null'::jsonb) then
    raise exception 'Invalid session mutation intent.' using errcode = '22023';
  end if;
  return intent;
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'Invalid session mutation intent.' using errcode = '22023';
end;
$$;

create or replace function internal.create_machine_session(p_actor internal.session_mutation_actor, p_intent jsonb)
returns jsonb language plpgsql set search_path = '' as $$
declare
  accepted record;
  admitted public.sessions;
  agent_id uuid;
  repository_id uuid;
begin
  if jsonb_typeof(p_intent) is distinct from 'object'
    or p_intent - 'title' - 'prompt' - 'agentId' - 'repositoryId' - 'draftSpecification' - 'workflowSelection' <> '{}'::jsonb
    or jsonb_typeof(p_intent->'title') is distinct from 'string'
    or jsonb_typeof(p_intent->'prompt') is distinct from 'string'
    or jsonb_typeof(p_intent->'agentId') is distinct from 'string'
    or jsonb_typeof(p_intent->'repositoryId') is distinct from 'string'
    or jsonb_typeof(p_intent->'draftSpecification') is distinct from 'boolean'
    or length(btrim(p_intent->>'title', E' \t\r\n')) not between 1 and 200
    or length(btrim(p_intent->>'prompt', E' \t\r\n')) not between 1 and 20000 then
    raise exception 'A title, prompt, named agent and writable repository are required.' using errcode = '22023';
  end if;
  agent_id := (p_intent->>'agentId')::uuid;
  repository_id := (p_intent->>'repositoryId')::uuid;
  if p_actor.service_principal_id is null or repository_id is distinct from p_actor.writer_repository_id then
    raise exception 'The requested factory execution grant is unavailable.' using errcode = '42501';
  end if;
  select * into strict accepted from internal.create_attributed_session(
    p_actor.workspace_id, null, p_intent->>'title', p_intent->>'prompt', null, null,
    session_github_repository_id=>repository_id, p_actor=>p_actor, p_expected_agent_id=>agent_id);
  if p_intent ? 'workflowSelection' then
    if (p_intent->>'draftSpecification')::boolean then
      raise exception 'Select a published workflow or draft a specification.' using errcode = '22023';
    end if;
    perform internal.bind_factory_workflow_intake_selection(p_actor.workspace_id, p_actor.factory_id,
      accepted.session_id, p_intent->'workflowSelection');
  elsif (p_intent->>'draftSpecification')::boolean then
    select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
    perform internal.pin_session_specification_stage(admitted);
  end if;
  return jsonb_build_object('sessionId', accepted.session_id, 'jobId', accepted.job_id, 'runId', accepted.run_id);
end;
$$;

drop function public.create_session_command_once(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[],uuid,uuid,boolean);
drop function public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean);

create or replace function public.find_session_creation_command(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  target_factory_id uuid default null, source_session_id uuid default null, draft_specification boolean default false, p_workflow_selection jsonb default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  accepted record;
  admitted public.sessions;
  receipt_factory_id uuid;
  prior_selection jsonb;
  selection jsonb := internal.normalize_factory_workflow_intake_selection(p_workflow_selection);
begin
  if draft_specification is null then raise exception 'Invalid specification drafting option.' using errcode = '22023'; end if;
  -- The original receipt lookup takes member access before returning. Fence
  -- the immutable receipt factory first, including standalone browser replay.
  select session.factory_id into receipt_factory_id
  from internal.session_creation_requests request
  join public.sessions session on (session.workspace_id, session.id) = (request.workspace_id, request.session_id)
  where (request.workspace_id, request.creator_member_id, request.request_id) =
    (target_workspace_id, find_session_creation_command.creator_member_id, target_request_id);
  if found then
    perform internal.assert_session_mutation_human_access(target_workspace_id, receipt_factory_id, creator_member_id);
  end if;
  select * into accepted from internal.find_session_creation_command(
    target_workspace_id, creator_member_id, target_request_id, target_request_hash, target_factory_id, source_session_id);
  if not found then return; end if;
  select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
  select jsonb_build_object('workflowId', pin.workflow_id, 'activationId', pin.activation_id)
    into prior_selection from internal.factory_workflow_authoring_session_pins pin
  where (pin.workspace_id, pin.factory_id, pin.session_id) = (admitted.workspace_id, admitted.factory_id, admitted.id);
  if draft_specification is distinct from (admitted.specification_stage_id is not null)
    or selection is distinct from prior_selection then
    raise exception 'This creation request was already used for different session input' using errcode = 'P0005';
  end if;
  -- A proven original browser receipt works after activation changes. Its
  -- immutable service grant must still be current when a shared receipt exists.
  if exists (
    select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id, receipt.session_id) =
      (target_workspace_id, admitted.factory_id, 'create', target_request_id, admitted.id)
      and receipt.grant_id is not null
  ) then
    perform internal.recheck_session_execution_grant(admitted);
  end if;
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;

create or replace function public.create_session_command_once(
  target_workspace_id uuid, creator_member_id uuid, target_request_id uuid, target_request_hash text,
  expected_factory_definition_digest text, session_title text, session_prompt_md text,
  agent_model_provider text, agent_model_name text, session_attachment_ids uuid[],
  session_linear_issue_id text default null, session_linear_issue_url text default null,
  session_github_repository_id uuid default null, selected_pipeline_id uuid default null,
  selected_stage_ids uuid[] default null, source_session_id uuid default null, target_factory_id uuid default null,
  draft_specification boolean default false, p_workflow_selection jsonb default null
) returns table(session_id uuid, session_number integer, workspace_slug text, job_id uuid, run_id uuid)
language plpgsql security definer set search_path = '' as $$
declare
  accepted record;
  admitted public.sessions;
  operation_actor internal.session_mutation_actor;
  definition jsonb;
  approved public.factory_execution_grants;
  actual_factory_id uuid;
  agent_id uuid;
  repository_id uuid;
  pipeline_id uuid;
  intent jsonb;
  prior jsonb;
  receipt_exists boolean;
  selection jsonb := internal.normalize_factory_workflow_intake_selection(p_workflow_selection);
begin
  if selection is not null and (draft_specification or source_session_id is not null
    or coalesce(expected_factory_definition_digest, '') = '') then
    raise exception 'A confirmed new factory session is required to select a published workflow.' using errcode = '22023';
  end if;
  if draft_specification is null or target_request_id is null
    or target_request_hash is null or target_request_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'A request identity, digest and valid specification option are required.' using errcode = '22023';
  end if;
  perform internal.assert_workspace_accepts_work(target_workspace_id);
  select factory.id into actual_factory_id from public.factories factory
  where factory.workspace_id = target_workspace_id
    and case when target_factory_id is null then factory.is_default else factory.id = target_factory_id end;
  if not found then raise exception 'The active factory changed.' using errcode = 'P0003'; end if;
  perform internal.assert_session_mutation_human_access(target_workspace_id, actual_factory_id, creator_member_id);
  perform internal.lock_session_mutation_key(target_workspace_id, actual_factory_id, 'create', target_request_id);

  -- Retain browser-only attachments, restart and per-member request handles.
  -- Acquire the shared key first for every keyed browser command.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'session-create:' || target_workspace_id::text || ':' || creator_member_id::text || ':' || target_request_id::text, 0));
  select * into accepted from public.find_session_creation_command(target_workspace_id, creator_member_id,
    target_request_id, target_request_hash, target_factory_id, source_session_id, draft_specification, selection);
  if found then
    return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
    return;
  end if;
  select exists (
    select 1 from internal.session_mutation_receipts receipt
    where (receipt.workspace_id, receipt.factory_id, receipt.operation, receipt.request_id) =
      (target_workspace_id, actual_factory_id, 'create', target_request_id)
  ) into receipt_exists;

  if source_session_id is null and coalesce(cardinality(session_attachment_ids), 0) = 0
    and session_linear_issue_id is null and session_linear_issue_url is null
    and length(btrim(session_title, E' \t\r\n')) between 1 and 200
    and length(btrim(session_prompt_md, E' \t\r\n')) between 1 and 20000 then
    -- Browser creation confirmed an immutable published revision. An exact
    -- replay may use it after a later activation, while fresh admission below
    -- must still match the active revision under the workspace admission lock.
    select revision.definition_json::jsonb into definition from public.factory_definition_revisions revision
    where (revision.workspace_id, revision.factory_id, revision.canonical_digest) =
      (target_workspace_id, actual_factory_id, expected_factory_definition_digest)
      and exists (
        select 1 from public.factory_definition_activations activation
        where (activation.workspace_id, activation.factory_id, activation.revision_id) =
          (revision.workspace_id, revision.factory_id, revision.id)
      );
    agent_id := (definition#>>'{implementationAgent,agentId}')::uuid;
    repository_id := (definition->>'repositoryId')::uuid;
    pipeline_id := (definition->>'pipelineId')::uuid;
    if definition ? 'executionGrant' and definition ? 'credentialBindingId' and agent_id is not null
      and (session_github_repository_id is null or session_github_repository_id = repository_id)
      and (selected_pipeline_id is null or selected_pipeline_id = pipeline_id)
      and (selected_stage_ids is null or selected_stage_ids =
        internal.read_factory_definition_stage_ids(target_workspace_id, pipeline_id, definition)) then
      approved := internal.resolve_definition_execution_grant(target_workspace_id, actual_factory_id,
        definition, repository_id, (definition->>'executionPolicyRevisionId')::uuid);
      operation_actor := row(target_workspace_id, actual_factory_id, creator_member_id, null, null,
        approved.id, approved.version, repository_id, null)::internal.session_mutation_actor;
      intent := jsonb_build_object('title', btrim(session_title, E' \t\r\n'), 'prompt', btrim(session_prompt_md, E' \t\r\n'),
        'agentId', agent_id, 'repositoryId', repository_id, 'draftSpecification', draft_specification);
      if selection is not null then
        intent := intent || jsonb_build_object('workflowSelection', selection);
      end if;
      prior := internal.find_session_mutation_receipt(operation_actor, 'create', target_request_id, intent);
      if prior is not null then
        -- Bind the compatible browser request for early replay before the
        -- application consults a later activation. The common receipt and
        -- its original actor retain their first-write provenance.
        insert into internal.session_creation_requests(workspace_id, creator_member_id, request_id, request_hash,
          session_id, job_id, run_id)
        values (target_workspace_id, creator_member_id, target_request_id, target_request_hash,
          (prior->>'sessionId')::uuid, (prior->>'jobId')::uuid, (prior->>'runId')::uuid);
        return query select (prior->>'sessionId')::uuid, (prior->>'sessionNumber')::integer, prior->>'workspaceSlug',
          (prior->>'jobId')::uuid, (prior->>'runId')::uuid;
        return;
      end if;
    end if;
  end if;

  if intent is not null then
    select * into strict accepted from internal.create_attributed_session(
      target_workspace_id, creator_member_id, intent->>'title', intent->>'prompt', agent_model_provider, agent_model_name,
      session_github_repository_id=>repository_id, selected_pipeline_id=>selected_pipeline_id, selected_stage_ids=>selected_stage_ids,
      p_actor=>operation_actor, p_expected_agent_id=>agent_id, p_expected_definition_digest=>expected_factory_definition_digest);
    insert into internal.session_creation_requests(workspace_id, creator_member_id, request_id, request_hash, session_id, job_id, run_id)
    values (target_workspace_id, creator_member_id, target_request_id, target_request_hash,
      accepted.session_id, accepted.job_id, accepted.run_id);
  else
    if receipt_exists then
      raise exception 'The session request identity was already used for different input.' using errcode = 'P0005';
    end if;
    select * into strict accepted from internal.create_session_command_once(
      target_workspace_id, creator_member_id, target_request_id, target_request_hash, expected_factory_definition_digest,
      session_title, session_prompt_md, agent_model_provider, agent_model_name, session_attachment_ids,
      session_linear_issue_id, session_linear_issue_url, session_github_repository_id, selected_pipeline_id,
      selected_stage_ids, source_session_id, target_factory_id);
    operation_actor := internal.session_mutation_human_actor(target_workspace_id, actual_factory_id, creator_member_id, accepted.session_id);
    intent := jsonb_build_object('browserRequestHash', target_request_hash);
    if selection is not null then
      intent := intent || jsonb_build_object('workflowSelection', selection);
    end if;
  end if;
  if selection is not null then
    perform internal.bind_factory_workflow_intake_selection(target_workspace_id, actual_factory_id,
      accepted.session_id, selection);
  elsif draft_specification then
    select session.* into strict admitted from public.sessions session where session.id = accepted.session_id;
    perform internal.pin_session_specification_stage(admitted);
  end if;
  perform internal.record_session_mutation_receipt(operation_actor, 'create', target_request_id, intent, accepted.session_id,
    jsonb_build_object('jobId', accepted.job_id, 'runId', accepted.run_id));
  return query select accepted.session_id, accepted.session_number, accepted.workspace_slug, accepted.job_id, accepted.run_id;
end;
$$;

revoke all on function public.create_session_command_once(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[],uuid,uuid,boolean,jsonb),
  public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.create_session_command_once(
  uuid,uuid,uuid,text,text,text,text,text,text,uuid[],text,text,uuid,uuid,uuid[],uuid,uuid,boolean,jsonb),
  public.find_session_creation_command(uuid,uuid,uuid,text,uuid,uuid,boolean,jsonb)
  to service_role;

-- Admissions offer the current compatible activation to factory members. No
-- drafts or workflow bytes cross this picker boundary.
create function public.list_factory_workflow_intake_options(p_workspace_id uuid, p_factory_id uuid)
returns table(workflow_id uuid, activation_id uuid, display_name text)
language sql stable security definer set search_path = '' as $$
  select workflow.id, published.id, workflow.display_name
  from internal.factory_workflow_authoring_workflows workflow
  join public.factories factory on (factory.workspace_id, factory.id) = (workflow.workspace_id, workflow.factory_id)
  cross join lateral internal.factory_workflow_authoring_base(p_workspace_id, p_factory_id) base
  cross join lateral (
    select activation.id, activation.base_activation_id
    from internal.factory_workflow_authoring_activations activation
    where activation.workflow_id = workflow.id
    order by activation.activation_number desc limit 1
  ) published
  where (workflow.workspace_id, workflow.factory_id) = (p_workspace_id, p_factory_id)
    and factory.status = 'active' and published.base_activation_id = base.id
    and auth.uid() is not null and internal.can_access_factory(p_workspace_id, p_factory_id)
    and not exists (
      select 1 from public.workspaces workspace
      where workspace.id = p_workspace_id and workspace.deletion_requested_at is not null
    )
  order by workflow.display_name, workflow.id
$$;
revoke all on function public.list_factory_workflow_intake_options(uuid,uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.list_factory_workflow_intake_options(uuid,uuid) to authenticated;
