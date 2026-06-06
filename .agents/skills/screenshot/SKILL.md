---
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
- If the PR description needs stable screenshot links, create a screenshot-only commit and push it only to obtain commit-SHA raw GitHub URLs.
- Update the PR description to use those commit-SHA raw URLs, then immediately run `git revert <screenshot-commit-sha>` and push the revert before final review.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
