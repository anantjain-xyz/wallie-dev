-- Clarify legacy explicit Review stages as review-and-fix loops.
--
-- New default pipelines no longer include an AI Review stage, but older and
-- customized pipelines can still have slug='review'. Replace Wallie-owned
-- legacy prompts and append a short addendum to custom prompts so their
-- existing instructions are preserved.

with legacy_full_review_prompt(value) as (
  values (
    'Review the implementation for: {{session.title}}' || E'\n\n' ||
    '## User Request' || E'\n\n' ||
    '{{session.prompt}}' || E'\n\n' ||
    '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
    '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
    '{{#if artifact.previousStages.build}}## Build Output' || E'\n\n' ||
    '{{artifact.previousStages.build}}' || E'\n{{/if}}' || E'\n\n' ||
    '{{#if attempt.feedback}}## Previous Feedback' || E'\n\n' ||
    '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
    '## Instructions' || E'\n\n' ||
    'Produce a structured review. Do not introduce new feature work.' || E'\n\n' ||
    '- **Verify against the plan** - confirm every acceptance-criteria and validation item is met; call out any gap.' || E'\n' ||
    '- **PR feedback sweep** - gather every actionable item from top-level PR comments, inline review comments, and review states. Each must be resolved (addressed or justified pushback); list any that remain open.' || E'\n' ||
    '- **Checks & evidence** - confirm CI is green on the latest commit, that user-facing changes include the required screenshots, and that validation test data has been cleaned up.' || E'\n' ||
    '- **Findings** - report risks, correctness concerns, and a clear recommendation. The change should not advance until findings are resolved and a human approves.' || E'\n'
  )
),
legacy_demo_review_prompt(value) as (
  values (
    E'Review the implementation for: {{session.title}}\n\n## Instructions\n\nProduce a structured review. Confirm every acceptance-criteria and validation item is met, sweep all actionable PR feedback to resolution, confirm CI is green on the latest commit, and report findings with a clear recommendation. Do not introduce new feature work.'
  )
),
new_review_stage(description, prompt) as (
  values (
    'Run a review-and-fix loop: verify the change, address PR feedback from bots and humans, and prepare it for human sign-off.',
    'Review the implementation for: {{session.title}}' || E'\n\n' ||
    '## User Request' || E'\n\n' ||
    '{{session.prompt}}' || E'\n\n' ||
    '{{#if artifact.previousStages.plan}}## Approved Plan' || E'\n\n' ||
    '{{artifact.previousStages.plan}}' || E'\n{{/if}}' || E'\n\n' ||
    '{{#if artifact.previousStages.build}}## Build Output' || E'\n\n' ||
    '{{artifact.previousStages.build}}' || E'\n{{/if}}' || E'\n\n' ||
    '{{#if attempt.feedback}}## Previous Feedback' || E'\n\n' ||
    '{{attempt.feedback}}' || E'\n{{/if}}' || E'\n\n' ||
    '## Instructions' || E'\n\n' ||
    'Run this as a review-and-fix loop for the existing implementation. Do not expand scope or introduce unrelated feature work. Code changes are allowed when they directly resolve review findings, PR feedback, failing checks, or plan gaps.' || E'\n\n' ||
    '- **Verify against the plan.** Confirm every acceptance-criteria and validation item is met; call out and fix any gap that is in scope.' || E'\n' ||
    '- **PR feedback sweep.** Gather every existing actionable item from bot and human feedback, including top-level PR comments, inline review comments or threads, review states such as changes requested, and failing check annotations. Resolve each with a code change or an explicit, justified response on the same thread or comment where appropriate.' || E'\n' ||
    '- **Loop until clear.** Rerun validation, push fixes, re-check CI and PR feedback, and repeat until no actionable feedback remains and no required checks are failing. Pending human-gated checks are fine; do not wait on them.' || E'\n' ||
    '- **Checks & evidence.** Confirm CI is green on the latest commit, user-facing changes include the required screenshots, and validation test data has been cleaned up.' || E'\n' ||
    '- **Findings.** Report risks, correctness concerns, what feedback was addressed, and a clear recommendation. The change should not advance until findings are resolved and a human approves.' || E'\n'
  )
),
review_loop_addendum(value) as (
  values (
    '## Review Loop' || E'\n\n' ||
    '- Treat this Review stage as a review-and-fix loop for the existing implementation. Do not expand scope or introduce unrelated feature work.' || E'\n' ||
    '- Code changes are allowed when they directly resolve review findings, PR feedback, failing checks, or plan gaps.' || E'\n' ||
    '- Gather every existing actionable item from bot and human feedback, including top-level PR comments, inline review comments or threads, review states such as changes requested, and failing check annotations.' || E'\n' ||
    '- Resolve each item with a code change or an explicit, justified response on the same thread or comment where appropriate. Rerun validation, push fixes, re-check CI and PR feedback, and repeat until no actionable feedback remains.' || E'\n'
  )
)
update public.pipeline_stages as stage
set
  description = case
    when stage.description = 'Sweep PR feedback and verify the change against the plan before human sign-off.'
      then new_review_stage.description
    else stage.description
  end,
  prompt_template_md = case
    when stage.prompt_template_md in (
      select value from legacy_full_review_prompt
      union all
      select value from legacy_demo_review_prompt
    )
      then new_review_stage.prompt
    when position('## Review Loop' in stage.prompt_template_md) = 0
      then stage.prompt_template_md || E'\n\n' || review_loop_addendum.value
    else stage.prompt_template_md
  end
from new_review_stage, review_loop_addendum
where stage.slug = 'review'
  and (
    stage.description = 'Sweep PR feedback and verify the change against the plan before human sign-off.'
    or stage.prompt_template_md in (
      select value from legacy_full_review_prompt
      union all
      select value from legacy_demo_review_prompt
    )
    or position('## Review Loop' in stage.prompt_template_md) = 0
  );
