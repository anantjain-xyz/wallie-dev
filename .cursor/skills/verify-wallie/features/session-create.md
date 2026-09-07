# Session create

Session create lets a signed-in workspace member open the New session composer, fill title/prompt (and optional stages/images), and start a session that lands on a creating preview then the session detail.

## Sub-features

- `create-open` opens the `Start a new session` dialog from the shell `New session` control.
- `create-submit` submits with `Start session` and shows a creating preview (`Creating session…`).
- `create-open-result` reaches the new session detail (or an `Open session` recovery action if the user navigated away mid-create).

## How to get to it (user POV)

- From Pipeline, Sessions, or Settings, choose `New session` in the workspace header.
- Open a workspace route with `?create=1` while signed in (composer deep-link).

## Driving it with control-wallie

Preconditions:

- Local Supabase is healthy with seed workspace `acme-corp` and completed onboarding (header shows `New session`, not `Resume setup`).
- `control-wallie doctor` passes.
- Browser is signed in: `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs sign-in --destination /w/acme-corp/sessions`.

- **Open composer.** Choose New session. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role button --name "New session"`. Dialog `Start a new session` appears.
- **Submit.** Fill the required fields the dialog exposes, then choose Start session. Run `... browser click --role button --name "Start session" --wait-for-text "Creating session…"`. The dialog closes and a creating preview is visible.
- **Proof.** Capture `create-before.png` / `create-after.png` plus an ARIA snapshot showing either the creating preview or the resulting session detail URL under `/w/acme-corp/sessions/`.

## Gotchas

- Incomplete onboarding replaces `New session` with `Resume setup`; that is an unmet precondition for this feature, not a harness failure.
- Failed or ambiguous creation may show `Retry creation` / `Open session` recovery controls — prove those only when intentionally testing recovery.
- Do not paste production credentials or attach private images in disposable verify runs.
