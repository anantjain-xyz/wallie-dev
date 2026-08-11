-- New workspaces use a two-stage plan -> build workflow. Existing pipeline
-- rows are intentionally left untouched so customized and in-flight workflows
-- keep their current stage membership and prompts.

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
      'Implement the approved plan, validate it, and open a review-ready PR for human sign-off.',
      'Implement: {{session.title}}' || E'\n\n' ||
      '## User Request' || E'\n\n' ||
      '{{session.prompt}}' || E'\n\n' ||
      '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
      '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
      '{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})' || E'\n\n' ||
      '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
      '## Instructions' || E'\n\n' ||
      'Implement the change against the approved plan, validate it, and publish a review-ready pull request. Read the codebase first and follow existing patterns. Work in small, focused commits.' || E'\n\n' ||
      '- **Sync first.** Before you start, sync the branch with the repository''s default branch and resolve any conflicts. Never publish on top of a conflicted branch.' || E'\n' ||
      '- **Pick up prior work.** If the branch already has commits from an earlier attempt, reconcile against them — build on what is there and address the feedback specifically rather than redoing committed work.' || E'\n' ||
      '- **Reproduction first.** Confirm the current behavior from the plan''s reproduction signal before changing code.' || E'\n' ||
      '- **Validation is mandatory.** Satisfy every acceptance-criteria and validation item from the plan. Prefer targeted proof that exercises the change; re-run until green before publishing.' || E'\n' ||
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover) and embed them in the PR description at stable URLs. Do not leave a throwaway screenshot commit in branch history.' || E'\n' ||
      '- **Open the pull request.** Summarize the diff shape, the commits, and the validation evidence produced.' || E'\n' ||
      '- **Stop after publication.** Report the PR and current check state, then return. Do not self-review the PR, wait for automated-review feedback, sweep reviewer comments, or merge the PR.' || E'\n'
    );
$$;

-- A NULL land-stage route means humans merge the PR themselves. New routing
-- rows inherit NULL while existing configured values (including "land") stay
-- unchanged and continue to opt into automated landing.
alter table public.workspace_linear_routing
  alter column land_stage_slug drop not null,
  alter column land_stage_slug drop default;
