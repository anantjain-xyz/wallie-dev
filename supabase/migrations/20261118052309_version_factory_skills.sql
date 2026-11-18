-- A factory definition selects skill revision IDs. Their content and source are
-- immutable, and revocation changes eligibility without changing retained runs.
create table public.factory_skills (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  slug text not null check (char_length(slug) between 1 and 60 and slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  unique (workspace_id, factory_id, id),
  unique (workspace_id, factory_id, slug),
  foreign key (workspace_id, factory_id) references public.factories(workspace_id, id) on delete cascade
);

create table public.factory_skill_revisions (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  factory_id uuid not null,
  skill_id uuid not null,
  revision_number integer not null check (revision_number > 0),
  content_md text not null check (btrim(content_md, E' \n\r\t') <> '' and char_length(content_md) <= 20000),
  content_sha256 text not null check (content_sha256 = encode(sha256(convert_to(content_md, 'UTF8')), 'hex')),
  source_kind text not null,
  source_ref text,
  created_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  revoked_by uuid,
  revoked_at timestamptz,
  unique (skill_id, revision_number),
  foreign key (workspace_id, factory_id, skill_id)
    references public.factory_skills(workspace_id, factory_id, id) on delete cascade,
  constraint factory_skill_revisions_source_check check (
    (source_kind = 'manual' and source_ref is null)
    or (
      source_kind in ('wallie_builtin', 'repository') and source_ref is not null
      and char_length(btrim(source_ref)) between 1 and 1024
    )
  ),
  constraint factory_skill_revisions_revocation_check
    check ((revoked_at is null) = (revoked_by is null))
);
create index factory_skill_revisions_factory_idx on public.factory_skill_revisions(workspace_id, factory_id, id);

alter table public.factory_skills enable row level security;
alter table public.factory_skill_revisions enable row level security;
revoke all on public.factory_skills, public.factory_skill_revisions from public, anon, authenticated, service_role;
grant select on public.factory_skills, public.factory_skill_revisions to authenticated, service_role;
create policy factory_skills_select on public.factory_skills for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));
create policy factory_skill_revisions_select on public.factory_skill_revisions for select to authenticated
  using (internal.can_access_factory(workspace_id, factory_id));

create function internal.preserve_factory_skill_history()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'DELETE' and not exists (
    select 1 from public.factories where (workspace_id, id) = (old.workspace_id, old.factory_id)
  ) then
    return old;
  end if;
  if tg_op = 'UPDATE' and tg_table_name = 'factory_skill_revisions' then
    if old.revoked_at is null and new.revoked_at is not null
      and (to_jsonb(old) - array['revoked_at', 'revoked_by']) = (to_jsonb(new) - array['revoked_at', 'revoked_by'])
    then
      return new;
    end if;
  end if;
  raise exception 'Skill identities and revision content are immutable.' using errcode = '23514';
end;
$$;
revoke all on function internal.preserve_factory_skill_history() from public, anon, authenticated, service_role;
create trigger preserve_factory_skills before update or delete on public.factory_skills
  for each row execute function internal.preserve_factory_skill_history();
create trigger preserve_factory_skill_revisions before update or delete on public.factory_skill_revisions
  for each row execute function internal.preserve_factory_skill_history();

alter table public.factory_audit_events drop constraint factory_audit_events_action_check;
alter table public.factory_audit_events add constraint factory_audit_events_action_check check (action in (
  'factory.created', 'factory.archived', 'factory.restored',
  'membership.granted', 'membership.revoked', 'membership.suspended', 'membership.reinstated',
  'agent.created', 'agent.prompt_revision_created',
  'skill.created', 'skill.revision_created', 'skill.revision_revoked'
));

-- Only provisioning wires in built-in trust. The manager APIs accept explicitly
-- authored instructions or repository Markdown that remains untrusted.
create function internal.add_factory_skill_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_actor_member_id uuid,
  p_skill_id uuid, p_revision_number integer, p_content_md text, p_source_kind text, p_source_ref text
) returns public.factory_skill_revisions
language plpgsql security invoker set search_path = '' as $$
declare result public.factory_skill_revisions; source_path text;
begin
  if p_source_kind is null or p_source_kind not in ('manual', 'repository') then
    raise exception 'Provide manual or repository skill content.' using errcode = 'PT422';
  end if;
  if p_source_kind = 'repository' then
    if p_source_ref is null or p_source_ref !~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@([0-9a-f]{40}|[0-9a-f]{64}):[^:]+$'
    then
      raise exception 'Provide a repository, exact commit, and skill file path.' using errcode = 'PT422';
    end if;
    source_path := split_part(p_source_ref, ':', 2);
    if char_length(source_path) > 900 or source_path ~ '(^|/)[.]{1,2}(/|$)|^/|/$|//|[[:cntrl:]]'
      or strpos(source_path, chr(92)) <> 0 then
      raise exception 'Provide a skill file path within the repository.' using errcode = 'PT422';
    end if;
    if not exists (
      select 1 from public.github_repositories repository
      where (repository.workspace_id, repository.factory_id, repository.id) =
        (p_workspace_id, p_factory_id, left(p_source_ref, 36)::uuid)
    ) then
      raise exception 'The source repository is unavailable in this factory.' using errcode = 'PT422';
    end if;
  end if;
  insert into public.factory_skill_revisions(
    workspace_id, factory_id, skill_id, revision_number, content_md, content_sha256, source_kind, source_ref, created_by
  ) values (
    p_workspace_id, p_factory_id, p_skill_id, p_revision_number, p_content_md,
    encode(sha256(convert_to(p_content_md, 'UTF8')), 'hex'), p_source_kind, p_source_ref, p_actor_user_id
  ) returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (
    p_workspace_id, p_factory_id, case when p_revision_number = 1 then 'skill.created' else 'skill.revision_created' end,
    p_actor_member_id, jsonb_build_object('skillId', p_skill_id, 'revisionId', result.id, 'revisionNumber', p_revision_number)
  );
  return result;
end;
$$;
revoke all on function internal.add_factory_skill_revision(uuid, uuid, uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;

create function public.create_factory_skill(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_name text, p_slug text, p_content_md text, p_source_kind text default 'manual', p_source_ref text default null
) returns public.factory_skill_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; created_skill_id uuid;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  insert into public.factory_skills(workspace_id, factory_id, name, slug, created_by)
  values (p_workspace_id, p_factory_id, btrim(p_name), p_slug, p_actor_user_id)
  returning id into created_skill_id;
  return internal.add_factory_skill_revision(
    p_workspace_id, p_factory_id, p_actor_user_id, actor_member_id, created_skill_id, 1,
    p_content_md, p_source_kind, p_source_ref
  );
end;
$$;
revoke all on function public.create_factory_skill(uuid, uuid, uuid, text, text, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.create_factory_skill(uuid, uuid, uuid, text, text, text, text, text) to service_role;

create function public.save_factory_skill_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_skill_id uuid,
  p_expected_revision_number integer, p_content_md text, p_source_kind text default 'manual', p_source_ref text default null
) returns public.factory_skill_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; current_revision integer;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  perform internal.assert_factory_accepts_work(p_workspace_id, p_factory_id);
  if not exists (
    select 1 from public.factory_skills
    where (workspace_id, factory_id, id) = (p_workspace_id, p_factory_id, p_skill_id)
  ) then
    raise exception 'Skill is unavailable in this factory.' using errcode = 'P0002';
  end if;
  -- The factory lock serializes writes to its skill registry.
  select max(revision_number) into current_revision from public.factory_skill_revisions where skill_id = p_skill_id;
  if p_expected_revision_number is distinct from current_revision then
    raise exception 'The skill changed. Reload its revision before saving.' using errcode = 'PT409';
  end if;
  return internal.add_factory_skill_revision(
    p_workspace_id, p_factory_id, p_actor_user_id, actor_member_id, p_skill_id, current_revision + 1,
    p_content_md, p_source_kind, p_source_ref
  );
end;
$$;
revoke all on function public.save_factory_skill_revision(uuid, uuid, uuid, uuid, integer, text, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.save_factory_skill_revision(uuid, uuid, uuid, uuid, integer, text, text, text) to service_role;

create function public.revoke_factory_skill_revision(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid, p_skill_id uuid, p_revision_id uuid
) returns public.factory_skill_revisions
language plpgsql security definer set search_path = '' as $$
declare actor_member_id uuid; result public.factory_skill_revisions;
begin
  perform internal.assert_checkpoint_publication_service();
  actor_member_id := internal.assert_factory_manager(p_workspace_id, p_factory_id, p_actor_user_id);
  select * into result from public.factory_skill_revisions
  where (workspace_id, factory_id, skill_id, id) = (p_workspace_id, p_factory_id, p_skill_id, p_revision_id);
  if not found then
    raise exception 'Skill revision is unavailable in this factory.' using errcode = 'P0002';
  end if;
  if result.revoked_at is not null then
    return result;
  end if;
  update public.factory_skill_revisions set revoked_by = p_actor_user_id, revoked_at = clock_timestamp()
  where id = p_revision_id returning * into result;
  insert into public.factory_audit_events(workspace_id, factory_id, action, actor_member_id, detail)
  values (
    p_workspace_id, p_factory_id, 'skill.revision_revoked', actor_member_id,
    jsonb_build_object('skillId', p_skill_id, 'revisionId', result.id, 'revisionNumber', result.revision_number)
  );
  return result;
end;
$$;
revoke all on function public.revoke_factory_skill_revision(uuid, uuid, uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.revoke_factory_skill_revision(uuid, uuid, uuid, uuid, uuid) to service_role;

create function internal.assert_factory_skill_bundle_available(
  p_workspace_id uuid, p_factory_id uuid, p_skill_ids jsonb
) returns void language plpgsql security invoker set search_path = '' as $$
declare revision_ids uuid[];
begin
  if p_skill_ids is null or p_skill_ids = '[]'::jsonb then
    return;
  end if;
  if jsonb_typeof(p_skill_ids) is distinct from 'array' then
    raise exception 'Select exact skill revision IDs.' using errcode = 'PT422';
  end if;
  if jsonb_array_length(p_skill_ids) > 20 then
    raise exception 'Select at most 20 skill revisions.' using errcode = 'PT422';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_skill_ids) ref
    where jsonb_typeof(ref) is distinct from 'string'
      or (ref #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ) then
    raise exception 'Select exact skill revision IDs.' using errcode = 'PT422';
  end if;
  select array_agg(ref::uuid) into revision_ids from jsonb_array_elements_text(p_skill_ids) ref;
  -- Admission and definition writes share the factory fence with revocation.
  -- The revision read takes place after that lock, even if revocation won.
  perform 1 from public.factories
  where (workspace_id, id) = (p_workspace_id, p_factory_id) for share;
  if cardinality(revision_ids) <> (
    select count(*) from public.factory_skill_revisions revision
    where (revision.workspace_id, revision.factory_id) = (p_workspace_id, p_factory_id)
      and revision.id = any(revision_ids) and revision.revoked_at is null
  ) then
    raise exception 'A selected skill revision is missing, revoked, or unavailable in this factory.' using errcode = 'PT422';
  end if;
end;
$$;
revoke all on function internal.assert_factory_skill_bundle_available(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

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
  perform internal.assert_factory_skill_bundle_available(p_workspace_id, p_factory_id, p_definition->'skillIds');
end;
$$;
revoke all on function internal.assert_factory_definition_resource_scope(uuid, uuid, jsonb)
  from public, anon, authenticated, service_role;

create function internal.guard_session_skill_admission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.execute_pinned_definition then
    perform internal.assert_factory_skill_bundle_available(
      new.workspace_id, new.factory_id, internal.pinned_session_execution_definition(new)->'skillIds'
    );
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_session_skill_admission() from public, anon, authenticated, service_role;
create trigger sessions_guard_skill_admission before insert on public.sessions
  for each row execute function internal.guard_session_skill_admission();

-- During rolling deployments an older worker can acquire a new session.
-- Its renderer cannot materialize a skill bundle, so fence its attempt
-- before it can start the agent.
create function internal.guard_attempt_skill_renderer()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if new.renderer_version < 3 and cardinality(new.definition_skill_ids) > 0
    and exists (
      select 1 from public.sessions session
      where (session.workspace_id, session.id) = (new.workspace_id, new.session_id)
        and session.execute_pinned_definition
    )
  then
    raise exception 'This worker cannot execute the pinned skill revisions.' using errcode = 'PT422';
  end if;
  return new;
end;
$$;
revoke all on function internal.guard_attempt_skill_renderer() from public, anon, authenticated, service_role;
create trigger guard_attempt_skill_renderer before insert on public.session_attempt_manifests
  for each row execute function internal.guard_attempt_skill_renderer();

-- Immutable snapshot of DEFAULT_WALLIE_SKILLS from repository onboarding v5.
-- Keep these bytes frozen. Add newer built-in content as a separate revision.
create function internal.provision_factory_builtin_skills(p_workspace_id uuid, p_factory_id uuid)
returns void language sql security invoker set search_path = '' as $$
  with catalog(slug, source_ref, content_md) as (values
    ('workpad', 'wallie-onboarding/v5/.agents/skills/workpad/SKILL.md', $skill$---
name: workpad
description: Manage the single Wallie Workpad comment on a Linear issue.
---

# Workpad

Use the Wallie Workpad as the issue's durable plan, acceptance, validation, and notes record.

Rules:
- Keep one workpad comment per Linear issue. Find the existing `## Wallie Workpad` comment before creating a new one.
- Update the workpad in place. If the Linear tool cannot edit in place, use the Linear GraphQL `commentUpdate` mutation.
- Do not put the PR URL in the workpad; attach it to the Linear issue.
- For rework, reset the existing workpad body in place rather than deleting it.

Minimum sections:
- `### Plan`
- `### Acceptance Criteria`
- `### Validation`
- `### Notes`
$skill$),
    ('pull', 'wallie-onboarding/v5/.agents/skills/pull/SKILL.md', $skill$---
name: pull
description: Merge origin/main into the working branch and resolve conflicts.
---

# Pull

Use this before implementation, before push, and during landing.

Steps:
- Ensure the working tree is clean or intentionally stashed.
- Run `git fetch origin`.
- Merge `origin/main` with `git -c merge.conflictstyle=zdiff3 merge origin/main`.
- Resolve conflicts by preserving the intent of both sides.
- Run the repo's required validation after the merge.
- Never use `git reset --hard`, `git clean -f`, or force push to escape conflicts.
$skill$),
    ('commit', 'wallie-onboarding/v5/.agents/skills/commit/SKILL.md', $skill$---
name: commit
description: Create a well-scoped git commit from the intended changes.
---

# Commit

Steps:
- Inspect `git status`, `git diff`, and `git diff --staged`.
- Stage only intended paths by name.
- Keep generated artifacts, logs, credentials, and screenshots out of normal commits and the final PR diff.
- Match the repository's commit-message style.
- Use `git commit -F <file>` for multi-line messages.
- Preserve Wallie's configured Git author and committer. Do not change `user.name` / `user.email`, use per-command identity config, pass `--author`, set `GIT_AUTHOR_*` or `GIT_COMMITTER_*`, or add `Co-authored-by` trailers.
- Do not bypass hooks unless a separate screenshot skill explicitly creates a temporary screenshot-only commit.
$skill$),
    ('push', 'wallie-onboarding/v5/.agents/skills/push/SKILL.md', $skill$---
name: push
description: Push the branch and ensure a GitHub pull request exists.
---

# Push

Steps:
- Confirm validation passed on the latest commit.
- Push with upstream tracking: `git push -u origin HEAD`.
- If push is rejected, merge the remote/base branch intentionally and rerun validation.
- Create or update a PR whose title/body describe the total branch scope using only the sandbox `gh` CLI (normally `gh pr create` or `gh pr edit`).
- Keep Wallie's injected `GH_TOKEN` unchanged. Do not unset, replace, or override it, and do not use a connected GitHub app, MCP server, plugin, browser session, or another API client for GitHub writes.
- Attach the PR URL to the Linear issue.
- Do not post duplicate completion comments.
$skill$),
    ('pr-feedback', 'wallie-onboarding/v5/.agents/skills/pr-feedback/SKILL.md', $skill$---
name: pr-feedback
description: Sweep GitHub PR feedback and resolve every actionable item.
---

# PR Feedback

Gather feedback from:
- Top-level PR comments from bots and humans.
- Inline review comments or threads from bots and humans.
- Review states such as changes requested.
- Check statuses, then failed check-run annotations when a check did not post a PR comment.

For failed check annotations:
```sh
pr=$(gh pr view --json number -q .number)
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
gh pr checks "$pr" --json name,state,bucket,link
gh api --paginate "repos/${repo}/commits/${sha}/check-runs"   --jq '.check_runs[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | [.id, .name, .conclusion, .details_url] | @tsv'
gh api --paginate "repos/${repo}/check-runs/<check_run_id>/annotations"
```

Resolution rules:
- Treat actionable bot or human feedback as blocking until fixed or explicitly answered with rationale.
- Reply on the same thread after addressing a comment.
- Rerun validation, push, and repeat the sweep before moving the issue back to review.
$skill$),
    ('screenshot', 'wallie-onboarding/v5/.agents/skills/screenshot/SKILL.md', $skill$---
name: screenshot
description: Capture Playwright proof screenshots for user-facing changes.
---

# Screenshot

Use repo-local Playwright or install it in the working copy when the repo does not provide it.

Preferred flow:
- Start the app locally using the repo's normal dev or preview command.
- If Playwright is missing, install it in the sandbox working copy with `npm install --no-save playwright` and `npx playwright install chromium`.
- Capture full-page screenshots for every reviewer-relevant state: happy path, loading, error, empty, mobile, and hover when applicable.
- Store temporary captures under `.wallie/screenshots/`.
- Screenshots are proof artifacts only and must never be part of the final PR diff.
- If the PR description needs screenshot proof, create a screenshot-only commit and push it so the screenshots are reviewable in one commit.
- Add one `Screenshot proof` link to the PR description using `https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`. Do not list or embed each screenshot file.
- Do not embed `raw.githubusercontent.com` or `media.githubusercontent.com` URLs from repo commits in private-repo PR descriptions. They require an auth header or expiring token and render as broken images in GitHub markdown.
- After updating the PR description, immediately run `git revert <screenshot-commit-sha>` and push the revert before final review.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
$skill$),
    ('land', 'wallie-onboarding/v5/.agents/skills/land/SKILL.md', $skill$---
name: land
description: Squash-merge an approved, green pull request and finish the Linear issue.
---

# Land

Use only when Linear routing has moved the issue to the configured merging status.

Steps:
- Confirm the PR is open, approved when review is required, mergeable, and checks are green.
- Merge `origin/main` first and rerun validation.
- Push the merge candidate.
- Wait for all checks to finish successfully.
- Squash-merge the PR.
- Verify the PR reaches `MERGED`, record the merge SHA in the workpad, and move the Linear issue to Done.
- If checks or mergeability fail and cannot be fixed, record the blocker and route to Rework.
$skill$)
  ), created_skills as (
    insert into public.factory_skills(workspace_id, factory_id, name, slug)
    select p_workspace_id, p_factory_id, initcap(replace(slug, '-', ' ')), slug
    from catalog
    on conflict (workspace_id, factory_id, slug) do nothing
    returning id, slug
  )
  insert into public.factory_skill_revisions(
    workspace_id, factory_id, skill_id, revision_number, content_md, content_sha256, source_kind, source_ref
  )
  select p_workspace_id, p_factory_id, created.id, 1, catalog.content_md,
    encode(sha256(convert_to(catalog.content_md, 'UTF8')), 'hex'), 'wallie_builtin', catalog.source_ref
  from created_skills created join catalog using (slug);
$$;
revoke all on function internal.provision_factory_builtin_skills(uuid, uuid)
  from public, anon, authenticated, service_role;

create function internal.provision_factory_builtin_skills_on_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform internal.provision_factory_builtin_skills(new.workspace_id, new.id);
  return new;
end;
$$;
revoke all on function internal.provision_factory_builtin_skills_on_insert() from public, anon, authenticated, service_role;
create trigger factories_provision_builtin_skills after insert on public.factories
  for each row execute function internal.provision_factory_builtin_skills_on_insert();

select internal.provision_factory_builtin_skills(workspace_id, id) from public.factories;

-- Eligibility uses the same skill availability check as activation and admission.
create or replace function public.read_factory_candidate_activation_eligibility(
  p_workspace_id uuid, p_factory_id uuid, p_actor_user_id uuid,
  p_target_kind text, p_target_id uuid, p_definition_digest text,
  p_enabled_sandbox_providers text[], p_required_probes text[]
) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  head public.factory_definition_activations;
  draft public.factory_definition_drafts;
  revision public.factory_definition_revisions;
  definition jsonb;
  digest text;
  metadata jsonb := '{}'::jsonb;
  base bigint;
  test_id uuid;
  can_test boolean;
  reason text;
begin
  perform 1 from public.workspaces w where w.id = p_workspace_id
    and w.deletion_requested_at is null for share;
  if not found then
    raise exception 'Factory workspace is unavailable.' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.workspace_members m where m.workspace_id = p_workspace_id
    and m.user_id = p_actor_user_id and m.kind = 'human' and m.is_active
    and m.role in ('owner','admin')) then
    raise exception 'Active workspace manager required.' using errcode = '42501';
  end if;
  perform 1 from public.factories f where (f.workspace_id, f.id) = (p_workspace_id, p_factory_id)
    and f.is_default for share;
  if not found then
    raise exception 'Factory is unavailable.' using errcode = 'P0002';
  end if;
  select a.* into head from public.factory_definition_activations a
    where (a.workspace_id, a.factory_id) = (p_workspace_id, p_factory_id)
    order by a.activation_number desc limit 1;
  base := coalesce(head.activation_number, 0);

  if p_target_kind = 'draft' then
    select d.* into draft from public.factory_definition_drafts d
      where (d.workspace_id, d.factory_id, d.id) = (p_workspace_id, p_factory_id, p_target_id);
    if not found then
      raise exception 'Factory definition draft is unavailable.' using errcode = 'P0002';
    end if;
    definition := draft.definition_json::jsonb;
    digest := draft.canonical_digest;
    metadata := draft.settings_metadata;
    if coalesce(draft.base_activation_number, 0) <> base then
      reason := 'The draft was saved against a different activation. Save a new draft before publishing.';
    elsif internal.latest_factory_draft_id(p_workspace_id, p_factory_id, base)
      is distinct from draft.id then
      reason := 'A newer draft is available. Reload the definition before publishing.';
    end if;
  elsif p_target_kind = 'revision' then
    select r.* into revision from public.factory_definition_revisions r
      where (r.workspace_id, r.factory_id, r.id) = (p_workspace_id, p_factory_id, p_target_id)
      and exists (select 1 from public.factory_definition_activations a
        where (a.workspace_id, a.factory_id, a.revision_id) = (r.workspace_id, r.factory_id, r.id));
    if not found then
      raise exception 'A previously active factory revision is required.' using errcode = 'P0002';
    end if;
    definition := revision.definition_json::jsonb;
    digest := revision.canonical_digest;
    if head.revision_id = revision.id then
      reason := 'This factory definition is already active.';
    end if;
  else
    raise exception 'A draft or revision is required.' using errcode = '22023';
  end if;

  if digest is distinct from p_definition_digest then
    raise exception 'The factory candidate digest changed. Reload the definition.' using errcode = 'PT409';
  end if;
  can_test := reason is null;
  if can_test then
    begin
      perform internal.assert_factory_skill_bundle_available(p_workspace_id, p_factory_id, definition->'skillIds');
    exception when sqlstate 'PT422' then
      reason := sqlerrm;
      can_test := false;
    end;
  end if;
  if can_test then
    begin
      perform internal.assert_factory_authority(p_workspace_id, p_actor_user_id, definition, digest,
        p_enabled_sandbox_providers, p_required_probes, metadata);
      perform internal.assert_factory_activation_smoke_test(p_workspace_id, p_factory_id, base,
        p_target_kind, p_target_id, digest, definition->>'sandboxProvider');
      -- The guard locks the latest receipt under the factory fence. Return its
      -- ID so the UI can reconcile independently fetched history with this result.
      select t.id into test_id from public.factory_definition_smoke_tests t
        where (t.workspace_id, t.factory_id, t.target_kind, t.target_id, t.base_activation_number, t.policy_version) =
          (p_workspace_id, p_factory_id, p_target_kind, p_target_id, base, 1)
        order by t.created_at desc, t.id desc limit 1;
    exception when sqlstate 'PT409' or sqlstate 'PT422' then
      reason := sqlerrm;
    end;
  end if;
  return jsonb_build_object('eligible', reason is null, 'reason', reason,
    'activationNumber', base, 'testId', test_id, 'canTest', can_test);
end;
$$;
revoke all on function public.read_factory_candidate_activation_eligibility(uuid,uuid,uuid,text,uuid,text,text[],text[])
  from public, anon, authenticated, service_role;
grant execute on function public.read_factory_candidate_activation_eligibility(uuid,uuid,uuid,text,uuid,text,text[],text[])
  to service_role;
