-- Keep Build commits and pull requests under the sandbox's Wallie identity.
-- Customized stage prompts stay byte-for-byte unchanged; only the exact prior
-- Build default is upgraded. A runtime-owned policy covers customized prompts.

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
      '- **Sync first.** Before you start, and again after addressing feedback, sync the branch with the repository''s default branch and resolve any conflicts. Never publish on top of a conflicted branch.' || E'\n' ||
      '- **Pick up prior work.** If the branch already has commits from an earlier attempt, reconcile against them — build on what is there and address the feedback specifically rather than redoing committed work.' || E'\n' ||
      '- **Reproduction first.** Confirm the current behavior from the plan''s reproduction signal before changing code.' || E'\n' ||
      '- **Validation is mandatory.** Satisfy every acceptance-criteria and validation item from the plan. Prefer targeted proof that exercises the change; re-run until green before publishing.' || E'\n' ||
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed in the PR description, create a screenshot-only commit, add one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`), then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.' || E'\n' ||
      '- **Publish with Wallie identity.** Preserve Wallie''s configured commit identity, push the branch, and create or update the pull request only with the sandbox `gh` CLI and its injected `GH_TOKEN`; the runtime policy below defines the non-overridable details.' || E'\n' ||
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
      '- Confirm the PR is approved and all required checks are green before merging. If checks are red or the branch conflicts, sync with the repository''s default branch and resolve them. If it cannot be made green, stop and report it for rework rather than force-merging.' || E'\n' ||
      '- Squash-merge the PR and record the resulting merge SHA.' || E'\n' ||
      '- Capture the rollout: tag or release if applicable, note any post-merge steps, and confirm the change is live.' || E'\n'
    );
$$;

with previous_default_build_prompt(value) as (
  values (
    'Implement: {{session.title}}' || E'\n\n' ||
    '## User Request' || E'\n\n' ||
    '{{session.prompt}}' || E'\n\n' ||
    '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
    '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
    '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
    '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
    '## Instructions' || E'\n\n' ||
    'Implement the change against the approved plan, then publish it and verify it for human review. Read the codebase first and follow existing patterns. Work in small, focused commits.' || E'\n\n' ||
    '- **Sync first.** Before you start, and again after addressing feedback, sync the branch with the repository''s default branch and resolve any conflicts. Never publish on top of a conflicted branch.' || E'\n' ||
    '- **Pick up prior work.** If the branch already has commits from an earlier attempt, reconcile against them — build on what is there and address the feedback specifically rather than redoing committed work.' || E'\n' ||
    '- **Reproduction first.** Confirm the current behavior from the plan''s reproduction signal before changing code.' || E'\n' ||
    '- **Validation is mandatory.** Satisfy every acceptance-criteria and validation item from the plan. Prefer targeted proof that exercises the change; re-run until green before publishing.' || E'\n' ||
    '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed in the PR description, create a screenshot-only commit, add one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`), then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.' || E'\n' ||
    '- **Open the pull request.** Summarize the diff shape, the commits, and the validation evidence produced.' || E'\n' ||
    '- **Sweep PR feedback.** Gather every actionable item from top-level PR comments, inline review comments, and review states. Resolve each — a code change or an explicit, justified pushback. Loop until none remain and no required checks are failing (pending human-gated checks are fine; do not wait on them).' || E'\n' ||
    '- **Verify against the plan.** Confirm every acceptance-criteria and validation item is met and CI is green on the latest commit; call out any gap. Close with a short verification summary so the human approver can sign off.' || E'\n'
  )
),
new_default_build_prompt(value) as (
  select prompt_template_md
  from internal.default_pipeline_stages()
  where slug = 'build'
)
update public.pipeline_stages as stage
set prompt_template_md = new_default_build_prompt.value
from previous_default_build_prompt, new_default_build_prompt
where stage.slug = 'build'
  and stage.prompt_template_md = previous_default_build_prompt.value;
