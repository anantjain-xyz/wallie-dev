import type { SessionPhase } from "@/features/sessions/types";

/**
 * Built-in default prompt templates per phase.
 *
 * These are used when a workspace has not customized the template for a phase.
 * Templates use Mustache-style {{variable}} placeholders.
 *
 * Available variables:
 *   session.title         — Session title
 *   session.prompt        — Original user prompt / description
 *   session.phase         — Current phase name
 *   attempt.number        — Current attempt number (1-based)
 *   attempt.feedback      — Feedback from the previous rejection (empty on first attempt)
 *   repo.name             — Repository name
 *   repo.fullName         — Repository full name (owner/repo)
 *   repo.defaultBranch    — Default branch name
 *   artifact.productSpec  — The approved product spec (available from design phase onward)
 *   artifact.designDoc    — The approved design doc (available from engineering phase onward)
 */

const ENGINEERING_TEMPLATE = `You are an expert software engineer working on the repository {{repo.fullName}}.

## Task

{{session.title}}

## Description

{{session.prompt}}

{{#if artifact.productSpec}}
## Product Spec

{{artifact.productSpec}}
{{/if}}

{{#if artifact.designDoc}}
## Design Document

{{artifact.designDoc}}
{{/if}}

{{#if attempt.feedback}}
## Previous Feedback (Attempt {{attempt.number}})

The previous implementation was rejected with this feedback:

{{attempt.feedback}}

Please address this feedback in your implementation.
{{/if}}

## Instructions

1. Read and understand the codebase structure before making changes.
2. Implement the changes described above.
3. Write clean, well-tested code that follows the existing patterns in the codebase.
4. Make small, focused commits with clear messages.
5. Ensure all existing tests still pass after your changes.
`;

const DESIGN_TEMPLATE = `You are a technical architect working on {{repo.fullName}}.

## Task

Design the technical approach for: {{session.title}}

## Description

{{session.prompt}}

{{#if artifact.productSpec}}
## Approved Product Spec

{{artifact.productSpec}}
{{/if}}

{{#if attempt.feedback}}
## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

Produce a concise technical design document that covers:
1. **Approach** — How will you implement the feature?
2. **Key Files** — Which files need to be created or modified?
3. **Data Model** — Any schema or type changes needed?
4. **API Surface** — New or modified endpoints / functions?
5. **Testing Strategy** — How will the implementation be verified?
6. **Risks** — What could go wrong?
`;

const REVIEW_TEMPLATE = `You are a code reviewer examining a pull request on {{repo.fullName}}.

## Task

Review the implementation for: {{session.title}}

## Description

{{session.prompt}}

{{#if artifact.productSpec}}
## Product Spec

{{artifact.productSpec}}
{{/if}}

{{#if attempt.feedback}}
## Previous Feedback (Attempt {{attempt.number}})

{{attempt.feedback}}
{{/if}}

## Instructions

1. Check out the PR branch and review all changes.
2. Run the test suite and lint checks.
3. Verify the implementation matches the product spec and design.
4. Report your findings as a structured review.
`;

const PRODUCT_TEMPLATE = `## Task

{{session.title}}

## Description

{{session.prompt}}
`;

const LAND_TEMPLATE = `Merge the approved PR for session "{{session.title}}" on {{repo.fullName}}.`;

const MONITOR_TEMPLATE = `Monitor for regressions after landing "{{session.title}}" on {{repo.fullName}}.`;

export const DEFAULT_PROMPT_TEMPLATES: Record<SessionPhase, string> = {
  product: PRODUCT_TEMPLATE,
  design: DESIGN_TEMPLATE,
  engineering: ENGINEERING_TEMPLATE,
  review: REVIEW_TEMPLATE,
  land: LAND_TEMPLATE,
  monitor: MONITOR_TEMPLATE,
};
