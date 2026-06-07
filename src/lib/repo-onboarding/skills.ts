import { createHash } from "node:crypto";

import { CURRENT_WALLIE_SKILL_VERSION } from "@/lib/repo-onboarding/contracts";

export const WALLIE_SKILL_VERSION = CURRENT_WALLIE_SKILL_VERSION;

export type DefaultWallieSkill = {
  content: string;
  name: string;
  path: string;
};

export const WALLIE_AGENTS_INSTRUCTIONS_PATH = "AGENTS.md";

function skill(name: string, description: string, body: string): DefaultWallieSkill {
  return {
    content: [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      "---",
      "",
      body.trim(),
      "",
    ].join("\n"),
    name,
    path: `.agents/skills/${name}/SKILL.md`,
  };
}

const WALLIE_COMMIT_SKILL_V1 = skill(
  "commit",
  "Create a well-scoped git commit from the intended changes.",
  `
# Commit

Steps:
- Inspect \`git status\`, \`git diff\`, and \`git diff --staged\`.
- Stage only intended paths by name.
- Keep generated artifacts, logs, credentials, and temporary screenshots out of normal commits.
- Match the repository's commit-message style.
- Use \`git commit -F <file>\` for multi-line messages.
- Do not bypass hooks unless a separate screenshot skill explicitly creates a throwaway screenshot commit.
`,
);

const WALLIE_SCREENSHOT_SKILL_V1 = skill(
  "screenshot",
  "Capture Playwright proof screenshots for user-facing changes.",
  `
# Screenshot

Use repo-local Playwright or install it in the working copy when the repo does not provide it.

Preferred flow:
- Start the app locally using the repo's normal dev or preview command.
- If Playwright is missing, install it in the sandbox working copy with \`npm install --no-save playwright\` and \`npx playwright install chromium\`.
- Capture full-page screenshots for every reviewer-relevant state: happy path, loading, error, empty, mobile, and hover when applicable.
- Store temporary captures under \`.wallie/screenshots/\`.
- Add screenshots to the PR description using raw GitHub URLs, then remove the temporary screenshot commit from branch history with \`git push --force-with-lease\`.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
`,
);

const WALLIE_PR_FEEDBACK_SKILL_V2 = skill(
  "pr-feedback",
  "Sweep GitHub PR feedback and resolve every actionable item.",
  `
# PR Feedback

Gather feedback from:
- Top-level PR comments.
- Inline review comments.
- Review states such as changes requested.

Resolution rules:
- Treat actionable feedback as blocking until fixed or explicitly answered with rationale.
- Reply on the same thread after addressing a comment.
- Rerun validation and push before moving the issue back to review.
`,
);

const WALLIE_AGENTS_INSTRUCTIONS_V1 = [
  "# Wallie Workflow",
  "",
  "This repository is configured for Wallie cloud execution.",
  "",
  "- Use repo-local skills under `.agents/skills/<name>/SKILL.md` for repeatable workflow mechanics.",
  "- The default workflow skills are `workpad`, `pull`, `commit`, `push`, `pr-feedback`, `screenshot`, and `land`.",
  "- Linear status routing is managed in Wallie settings; do not hard-code status names in repo scripts.",
  "- Keep changes scoped to the active issue branch and avoid overwriting unrelated user work.",
  "- For user-facing changes, use the `screenshot` skill and Playwright CLI proof when available.",
  "",
].join("\n");

export const UPGRADABLE_WALLIE_LEGACY_FILES = [
  { content: WALLIE_COMMIT_SKILL_V1.content, path: WALLIE_COMMIT_SKILL_V1.path },
  { content: WALLIE_PR_FEEDBACK_SKILL_V2.content, path: WALLIE_PR_FEEDBACK_SKILL_V2.path },
  { content: WALLIE_SCREENSHOT_SKILL_V1.content, path: WALLIE_SCREENSHOT_SKILL_V1.path },
  { content: WALLIE_AGENTS_INSTRUCTIONS_V1, path: WALLIE_AGENTS_INSTRUCTIONS_PATH },
] as const;

export const DEFAULT_WALLIE_SKILLS: DefaultWallieSkill[] = [
  skill(
    "workpad",
    "Manage the single Wallie Workpad comment on a Linear issue.",
    `
# Workpad

Use the Wallie Workpad as the issue's durable plan, acceptance, validation, and notes record.

Rules:
- Keep one workpad comment per Linear issue. Find the existing \`## Wallie Workpad\` comment before creating a new one.
- Update the workpad in place. If the Linear tool cannot edit in place, use the Linear GraphQL \`commentUpdate\` mutation.
- Do not put the PR URL in the workpad; attach it to the Linear issue.
- For rework, reset the existing workpad body in place rather than deleting it.

Minimum sections:
- \`### Plan\`
- \`### Acceptance Criteria\`
- \`### Validation\`
- \`### Notes\`
`,
  ),
  skill(
    "pull",
    "Merge origin/main into the working branch and resolve conflicts.",
    `
# Pull

Use this before implementation, before push, and during landing.

Steps:
- Ensure the working tree is clean or intentionally stashed.
- Run \`git fetch origin\`.
- Merge \`origin/main\` with \`git -c merge.conflictstyle=zdiff3 merge origin/main\`.
- Resolve conflicts by preserving the intent of both sides.
- Run the repo's required validation after the merge.
- Never use \`git reset --hard\`, \`git clean -f\`, or force push to escape conflicts.
`,
  ),
  skill(
    "commit",
    "Create a well-scoped git commit from the intended changes.",
    `
# Commit

Steps:
- Inspect \`git status\`, \`git diff\`, and \`git diff --staged\`.
- Stage only intended paths by name.
- Keep generated artifacts, logs, credentials, and screenshots out of normal commits and the final PR diff.
- Match the repository's commit-message style.
- Use \`git commit -F <file>\` for multi-line messages.
- Do not bypass hooks unless a separate screenshot skill explicitly creates a temporary screenshot-only commit.
`,
  ),
  skill(
    "push",
    "Push the branch and ensure a GitHub pull request exists.",
    `
# Push

Steps:
- Confirm validation passed on the latest commit.
- Push with upstream tracking: \`git push -u origin HEAD\`.
- If push is rejected, merge the remote/base branch intentionally and rerun validation.
- Create or update a PR whose title/body describe the total branch scope.
- Attach the PR URL to the Linear issue.
- Do not post duplicate completion comments.
`,
  ),
  skill(
    "pr-feedback",
    "Sweep GitHub PR feedback and resolve every actionable item.",
    `
# PR Feedback

Gather feedback from:
- Top-level PR comments from bots and humans.
- Inline review comments or threads from bots and humans.
- Review states such as changes requested.
- Check statuses, then failed check-run annotations when a check did not post a PR comment.

For failed check annotations:
\`\`\`sh
pr=$(gh pr view --json number -q .number)
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
sha=$(gh pr view "$pr" --json headRefOid -q .headRefOid)
gh pr checks "$pr" --json name,state,bucket,link
gh api --paginate "repos/\${repo}/commits/\${sha}/check-runs" \
  --jq '.check_runs[] | select(.conclusion != null and .conclusion != "success" and .conclusion != "skipped" and .conclusion != "neutral") | [.id, .name, .conclusion, .details_url] | @tsv'
gh api --paginate "repos/\${repo}/check-runs/<check_run_id>/annotations"
\`\`\`

Resolution rules:
- Treat actionable bot or human feedback as blocking until fixed or explicitly answered with rationale.
- Reply on the same thread after addressing a comment.
- Rerun validation, push, and repeat the sweep before moving the issue back to review.
`,
  ),
  skill(
    "screenshot",
    "Capture Playwright proof screenshots for user-facing changes.",
    `
# Screenshot

Use repo-local Playwright or install it in the working copy when the repo does not provide it.

Preferred flow:
- Start the app locally using the repo's normal dev or preview command.
- If Playwright is missing, install it in the sandbox working copy with \`npm install --no-save playwright\` and \`npx playwright install chromium\`.
- Capture full-page screenshots for every reviewer-relevant state: happy path, loading, error, empty, mobile, and hover when applicable.
- Store temporary captures under \`.wallie/screenshots/\`.
- Screenshots are proof artifacts only and must never be part of the final PR diff.
- If the PR description needs stable screenshot links, create a screenshot-only commit and push it only to obtain commit-SHA raw GitHub URLs.
- Update the PR description to use those commit-SHA raw URLs, then immediately run \`git revert <screenshot-commit-sha>\` and push the revert before final review.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
`,
  ),
  skill(
    "land",
    "Squash-merge an approved, green pull request and finish the Linear issue.",
    `
# Land

Use only when Linear routing has moved the issue to the configured merging status.

Steps:
- Confirm the PR is open, approved when review is required, mergeable, and checks are green.
- Merge \`origin/main\` first and rerun validation.
- Push the merge candidate.
- Wait for all checks to finish successfully.
- Squash-merge the PR.
- Verify the PR reaches \`MERGED\`, record the merge SHA in the workpad, and move the Linear issue to Done.
- If checks or mergeability fail and cannot be fixed, record the blocker and route to Rework.
`,
  ),
];

export const WALLIE_AGENTS_INSTRUCTIONS = [
  "# Wallie Workflow",
  "",
  "This repository is configured for Wallie cloud execution.",
  "",
  "- Use repo-local skills under `.agents/skills/<name>/SKILL.md` for repeatable workflow mechanics.",
  "- The default workflow skills are `workpad`, `pull`, `commit`, `push`, `pr-feedback`, `screenshot`, and `land`.",
  "- Linear status routing is managed in Wallie settings; do not hard-code status names in repo scripts.",
  "- Keep changes scoped to the active issue branch and avoid overwriting unrelated user work.",
  "- For user-facing changes, use the `screenshot` skill and Playwright CLI proof when available.",
  "- Screenshots are proof artifacts only; never leave them in the final PR diff.",
  "",
].join("\n");

export function wallieSkillManifestHash(
  skills: readonly DefaultWallieSkill[] = DEFAULT_WALLIE_SKILLS,
) {
  const hash = createHash("sha256");
  for (const entry of [...skills].sort((left, right) => left.path.localeCompare(right.path))) {
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.content);
    hash.update("\0");
  }
  hash.update(WALLIE_AGENTS_INSTRUCTIONS);
  return hash.digest("hex");
}
