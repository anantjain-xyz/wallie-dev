-- Make the default Product stage produce a product artifact instead of
-- inviting implementation work, and migrate unchanged existing defaults.

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
      'product',
      'Product',
      'Write the product spec and approve the problem framing.',
      $prompt$## Product Spec Request

{{session.title}}

## User Request

{{session.prompt}}

{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

Produce a reviewable product specification only. Do not modify files, run implementation commands, create branches, install dependencies, or make code changes.

Cover:
- Problem and goals
- Non-goals
- Target users and workflows
- Functional requirements
- Acceptance criteria
- Open questions and risks
$prompt$
    ),
    (
      2,
      'design',
      'Design',
      'Resolve the design approach before engineering picks it up.',
      $prompt$Design the technical approach for: {{session.title}}

## Description

{{session.prompt}}

{{#if artifact.previousStages.product}}## Approved Product Spec

{{artifact.previousStages.product}}
{{/if}}

{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

Produce a concise technical design document that covers approach, key files, data model, API surface, testing, and risks.
$prompt$
    ),
    (
      3,
      'engineering',
      'Engineering',
      'Scope the implementation plan and confirm the diff shape.',
      $prompt$Implement: {{session.title}}

## Description

{{session.prompt}}

{{#if artifact.previousStages.product}}## Product Spec

{{artifact.previousStages.product}}
{{/if}}

{{#if artifact.previousStages.design}}## Design Document

{{artifact.previousStages.design}}
{{/if}}

{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

Read the codebase, implement the change, follow existing patterns, and produce small focused commits.
$prompt$
    ),
    (
      4,
      'review',
      'Review',
      'Human review of the generated change set.',
      $prompt$Review the implementation for: {{session.title}}

## Description

{{session.prompt}}

{{#if artifact.previousStages.engineering}}## Engineering Output

{{artifact.previousStages.engineering}}
{{/if}}

{{#if attempt.feedback}}## Previous Feedback

{{attempt.feedback}}
{{/if}}

## Instructions

Verify the implementation matches the spec, call out risks, and report findings as a structured review.
$prompt$
    ),
    (
      5,
      'land',
      'Land',
      'Merge, tag, and roll out.',
      'Merge the approved change for "{{session.title}}". Confirm CI is green and the rollout plan is captured below.' || E'\n'
    ),
    (
      6,
      'monitor',
      'Monitor',
      'Watch for regressions. Terminal phase - approving archives.',
      $prompt$Verify that landing "{{session.title}}" has not introduced regressions.

## Description

{{session.prompt}}

## Instructions

Run tests, lint, and a smoke check; produce a monitoring report with pass/fail status.
$prompt$
    );
$$;

with prompts as (
  select
    '## Task' || E'\n\n' ||
    '{{session.title}}' || E'\n\n' ||
    '## Description' || E'\n\n' ||
    '{{session.prompt}}' || E'\n' as old_product_prompt,
    $prompt$## Product Spec Request

{{session.title}}

## User Request

{{session.prompt}}

{{#if attempt.feedback}}## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

Produce a reviewable product specification only. Do not modify files, run implementation commands, create branches, install dependencies, or make code changes.

Cover:
- Problem and goals
- Non-goals
- Target users and workflows
- Functional requirements
- Acceptance criteria
- Open questions and risks
$prompt$ as new_product_prompt
)
update public.pipeline_stages ps
set
  description = 'Write the product spec and approve the problem framing.',
  prompt_template_md = prompts.new_product_prompt
from prompts
where ps.slug = 'product'
  and ps.prompt_template_md = prompts.old_product_prompt;
