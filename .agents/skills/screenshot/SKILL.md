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
- If the PR description needs screenshot proof, create a screenshot-only commit and push it so the screenshots are reviewable in one commit.
- Add one `Screenshot proof` link to the PR description using `https://github.com/<owner>/<repo>/commit/<screenshot-commit-sha>`. Do not list or embed each screenshot file.
- Do not embed `raw.githubusercontent.com` or `media.githubusercontent.com` URLs from repo commits in private-repo PR descriptions. They require an auth header or expiring token and render as broken images in GitHub markdown.
- After updating the PR description, immediately run `git revert <screenshot-commit-sha>` and push the revert before final review.

Do not rely on a Playwright MCP server being present in Wallie cloud runs.
