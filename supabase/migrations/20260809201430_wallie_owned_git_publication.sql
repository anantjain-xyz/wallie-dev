-- Keep Git publication under Wallie's identity. Existing customized operating
-- rules and stage prompts stay untouched; only the exact prior defaults move.

update public.pipeline_stages as stage
set
  description = case
    when stage.description = 'Implement the approved plan, validate, open a PR, sweep PR feedback, and verify against the plan for human sign-off.'
      then 'Implement the approved plan, validate, publish the branch for a Wallie-managed PR, sweep PR feedback, and verify against the plan for human sign-off.'
    else stage.description
  end,
  prompt_template_md = replace(
    replace(
      stage.prompt_template_md,
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed in the PR description, create a screenshot-only commit, add one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`), then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.',
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed, create a screenshot-only commit, include one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`) in the final Build output, then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Wallie uses the Build output as the PR description. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.'
    ),
    '- **Open the pull request.** Summarize the diff shape, the commits, and the validation evidence produced.',
    '- **Publish through Wallie.** Commit and push the branch, then summarize the diff shape, the commits, and the validation evidence produced. Do not create or update a pull request through the GitHub CLI, a connected GitHub integration, an MCP/app tool, or any other path, and do not attach a PR URL to Linear. Wallie creates and records the pull request after this run. Preserve Wallie''s configured Git identity: do not change the author or committer configuration, set identity environment overrides, or pass `--author`.'
  )
where stage.slug = 'build'
  and stage.prompt_template_md = (
    select defaults.prompt_template_md
    from internal.default_pipeline_stages() as defaults
    where defaults.slug = 'build'
  );

update public.pipelines as pipeline
set operating_rules_md = replace(
  pipeline.operating_rules_md,
  '- **Screenshot hygiene.** Screenshots are proof artifacts only and must never be part of the final PR diff. If you need GitHub screenshot proof, create a screenshot-only commit, push it, add one screenshot proof commit link to the PR description, then immediately run `git revert <screenshot-commit-sha>` and push the revert before final review. Do not use `raw.githubusercontent.com` or `media.githubusercontent.com` screenshot embeds from repo commits in private repositories; they require auth or expiring tokens and render broken.',
  '- **Screenshot hygiene.** Screenshots are proof artifacts only and must never be part of the final PR diff. If you need GitHub screenshot proof, create a screenshot-only commit, push it, include one screenshot proof commit link in the final Build output, then immediately run `git revert <screenshot-commit-sha>` and push the revert before final review. Wallie uses the Build output as the PR description. Do not use `raw.githubusercontent.com` or `media.githubusercontent.com` screenshot embeds from repo commits in private repositories; they require auth or expiring tokens and render broken.'
)
where pipeline.operating_rules_md = internal.default_pipeline_operating_rules();

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
      'Implement the approved plan, validate, publish the branch for a Wallie-managed PR, sweep PR feedback, and verify against the plan for human sign-off.',
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
      '- **User-facing changes.** Capture full-page screenshots of every state worth reviewing (happy path, loading, error, empty, mobile, hover). If screenshot proof is needed, create a screenshot-only commit, include one screenshot proof commit link (`https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`) in the final Build output, then immediately revert it with `git revert <screenshot-commit-sha>` and push the revert before final review. Wallie uses the Build output as the PR description. Do not list or embed each screenshot file; screenshots must never be part of the final PR diff.' || E'\n' ||
      '- **Publish through Wallie.** Commit and push the branch, then summarize the diff shape, the commits, and the validation evidence produced. Do not create or update a pull request through the GitHub CLI, a connected GitHub integration, an MCP/app tool, or any other path, and do not attach a PR URL to Linear. Wallie creates and records the pull request after this run. Preserve Wallie''s configured Git identity: do not change the author or committer configuration, set identity environment overrides, or pass `--author`.' || E'\n' ||
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
    '- **Screenshot hygiene.** Screenshots are proof artifacts only and must never be part of the final PR diff. If you need GitHub screenshot proof, create a screenshot-only commit, push it, include one screenshot proof commit link in the final Build output, then immediately run `git revert <screenshot-commit-sha>` and push the revert before final review. Wallie uses the Build output as the PR description. Do not use `raw.githubusercontent.com` or `media.githubusercontent.com` screenshot embeds from repo commits in private repositories; they require auth or expiring tokens and render broken.' || E'\n' ||
    '- **Leave no residue.** Anything you create in external systems while validating (tracker issues/comments, scratch branches or draft PRs, rows in shared databases) must be removed before you finish. End state = start state plus only the artifacts that belong to this change.' || E'\n' ||
    '- **Report honestly.** Your final summary states what you actually did and any blockers — no "next steps for the user," no unverified claims. If validation failed, say so with the evidence.' || E'\n';
$$;
