-- Align the default pipeline with Symphony's WORKFLOW.md and add editable,
-- per-pipeline operating rules.
--
-- Forward migration: the init migration (20260422000000_init.sql) was already
-- applied in production, so these changes ship as a new version rather than an
-- edit to init.
--
-- Two things happen here:
--   1. The default seed drops the AI "review" stage. Symphony's review is a
--      human gate, which Wallie already provides via the per-stage approval
--      gate, so the defaults become plan -> build -> land. The PR-feedback sweep
--      and verify-against-plan steps fold into build; build's old cleanup bullet
--      moves into the shared operating rules below.
--   2. Operating rules become a stored, per-pipeline field (pipelines.
--      operating_rules_md) prepended to every rendered stage prompt. They are
--      seeded from internal.default_pipeline_operating_rules() and editable from
--      the settings and onboarding pipeline editors.
--
-- Existing workspaces keep their stage prompts (no backfill of pipeline_stages);
-- they gain operating_rules_md from the column default.

-- ---------------------------------------------------------------------------
-- Default stage seed: plan -> build -> land
-- ---------------------------------------------------------------------------

create or replace function internal.default_pipeline_stages()
returns table (
  stage_position integer,
  slug text,
  name text,
  description text,
  prompt_template_md text
)
language sql
immutable
set search_path = ''
as $$
  values
    (
      1,
      'plan',
      'Plan',
      'Frame the problem and lock the plan: spec, acceptance criteria, technical approach, and reproduction signal.',
      '## Plan Request' || E'\n\n' ||
      '{{session.title}}' || E'\n\n' ||
      '## User Request' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Produce a reviewable plan only. Do not modify files, run implementation commands, create branches, install dependencies, or make code changes.' || E'\n\n' ||
      'Cover:' || E'\n' ||
      '- **Problem & goals** — what we are solving and why, plus explicit non-goals.' || E'\n' ||
      '- **Acceptance criteria** — a concrete checklist the Build stage will tick off item by item. If the request names any validation, test plan, or testing steps, copy them verbatim as required items (no optional downgrade). For user-facing work, include a UI walkthrough (launch path → interaction → expected result) as a required criterion.' || E'\n' ||
      '- **Reproduction signal** — the current behavior before any change: the command, output, or UI state that demonstrates the problem (or confirms the feature is absent).' || E'\n' ||
      '- **Technical approach** — key files, data model, API surface, and how the change fits existing patterns.' || E'\n' ||
      '- **Validation plan** — how the change will be proven, including screenshots for user-facing states.' || E'\n' ||
      '- **Risks & open questions.**' || E'\n'
    ),
    (
      2,
      'build',
      'Build',
      'Implement the approved plan, validate, open a PR, sweep PR feedback, and verify against the plan for human sign-off.',
      'Implement: {{session.title}}' || E'\n\n' ||
      '## User Request' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
      '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Implement the change against the approved plan, then publish it and verify it for human review. Read the codebase first and follow existing patterns. Work in small, focused commits.' || E'\n\n' ||
      '- **Sync first.** Before you start, and again after addressing feedback, sync the branch with {{repo.defaultBranch}} and resolve any conflicts. Never publish on top of a conflicted branch.' || E'\n' ||
      '- **Pick up prior work.** If the branch already has commits from an earlier attempt, reconcile against them — build on what is there and address the feedback specifically rather than redoing committed work.' || E'\n' ||
      '- **Reproduction first.** Confirm the current behavior from the plan''s reproduction signal before changing code.' || E'\n' ||
      '- **Validation is mandatory.** Satisfy every acceptance-criteria and validation item from the plan. Prefer targeted proof that exercises the change; re-run until green before publishing.' || E'\n' ||
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover) and embed them in the PR description at stable URLs. Do not leave a throwaway screenshot commit in branch history.' || E'\n' ||
      '- **Open the pull request.** Summarize the diff shape, the commits, and the validation evidence produced.' || E'\n' ||
      '- **Sweep PR feedback.** Gather every actionable item from top-level PR comments, inline review comments, and review states. Resolve each — a code change or an explicit, justified pushback. Loop until none remain and no required checks are failing (pending human-gated checks are fine; do not wait on them).' || E'\n' ||
      '- **Verify against the plan.** Confirm every acceptance-criteria and validation item is met and CI is green on the latest commit; call out any gap. Close with a short verification summary so the human approver can sign off.' || E'\n'
    ),
    (
      3,
      'land',
      'Land',
      'Merge the approved change once CI is green, and capture the rollout.',
      'Land the approved change for "{{session.title}}".' || E'\n\n' ||
      '{{#if artifact.previousStages.build}}## Build Output' || E'\n\n' ||
      '{{artifact.previousStages.build}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      '- Confirm the PR is approved and all required checks are green before merging. If checks are red or the branch conflicts, sync with {{repo.defaultBranch}} and resolve them. If it cannot be made green, stop and report it for rework rather than force-merging.' || E'\n' ||
      '- Squash-merge the PR and record the resulting merge SHA.' || E'\n' ||
      '- Capture the rollout: tag or release if applicable, note any post-merge steps, and confirm the change is live.' || E'\n'
    );
$$;

-- ---------------------------------------------------------------------------
-- Operating rules: shared, per-pipeline preamble prepended to every stage
-- ---------------------------------------------------------------------------

-- Single source of truth for the seeded default. Reusable by a future
-- "Reset to defaults" button. Mirrors the cross-cutting discipline Symphony
-- keeps in its system prompt.
create or replace function internal.default_pipeline_operating_rules()
returns text
language sql
immutable
set search_path = ''
as $$
  select
    '## Operating rules' || E'\n\n' ||
    'You are running unattended inside an automated pipeline. These rules apply at every stage.' || E'\n\n' ||
    '- **Autonomous.** Never ask a human for follow-up or wait for input. Only stop early for a true external blocker — missing non-GitHub auth, secrets, or tools you cannot work around. Report it plainly: what is missing, why it blocks, and the exact action to unblock.' || E'\n' ||
    '- **Stay in scope.** Work only in the provided repository and follow its existing patterns (read its AGENTS.md / CLAUDE.md first). Do not expand the change beyond what this session asks; file any out-of-scope improvement as a separate follow-up.' || E'\n' ||
    '- **Git safety.** Never use --no-verify, git reset --hard, git push --force / --force-with-lease, or git clean -f unless explicitly asked. Never run broad process kills (pkill -f, killall, loose pgrep -f) — you share the host; scope cleanup to a specific port or process.' || E'\n' ||
    '- **Leave no residue.** Anything you create in external systems while validating (tracker issues/comments, scratch branches or draft PRs, rows in shared databases) must be removed before you finish. End state = start state plus only the artifacts that belong to this change.' || E'\n' ||
    '- **Report honestly.** Your final summary states what you actually did and any blockers — no "next steps for the user," no unverified claims. If validation failed, say so with the evidence.' || E'\n';
$$;

-- New pipelines (via create_workspace, which inserts without listing columns)
-- inherit the default. Existing pipeline rows backfill to the same default.
alter table public.pipelines
  add column if not exists operating_rules_md text not null
  default internal.default_pipeline_operating_rules();

-- ---------------------------------------------------------------------------
-- rewrite_default_pipeline: persist operating rules alongside name + stages
-- ---------------------------------------------------------------------------

-- Drop the 3-arg signature so we can add the operating_rules_md parameter.
drop function if exists public.rewrite_default_pipeline(uuid, text, jsonb);

create function public.rewrite_default_pipeline(
  target_workspace_id uuid,
  pipeline_name text,
  stage_payload jsonb,
  operating_rules_md text default ''
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
  set
    name = coalesce(pipeline_name, 'Default'),
    operating_rules_md = coalesce(rewrite_default_pipeline.operating_rules_md, '')
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

-- Restore the security posture from init for the recreated signature.
revoke all on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.rewrite_default_pipeline(uuid, text, jsonb, text)
  to service_role;
