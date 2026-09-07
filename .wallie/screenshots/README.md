# Muted UI borders: screenshot proof

Start with `settings-dark-before.png` and `settings-dark-after.png` for the main before/after comparison. `settings-light-after.png` shows the light theme. The remaining captures cover the mobile repository editor, Settings subsections, loading/empty/error states, dialogs, selects, notifications, and other pages.

Captured through the local Playwright-backed browser using real components and deterministic fixture data. Desktop: 1440×1100. Mobile: 390×844. Theme transitions were allowed to settle before final captures. The small Next.js development indicator is not application UI.

The Settings fixture runs without an authenticated workspace. Its provider-status request returns 401, visible in the agent/sandbox captures; these images verify appearance rather than integration behavior.
