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
- Add screenshots to the PR description using raw GitHub URLs, then remove the temporary screenshot commit from branch history with `git push --force-with-lease`.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
