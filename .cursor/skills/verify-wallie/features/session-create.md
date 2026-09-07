# Session create

Session create lets a signed-in workspace member open the New session composer, fill title/prompt (and optional stages/images), and start a session that lands on a creating preview then the session detail.

## Sub-features

- `create-open` opens the `Start a new session` dialog from the shell `New session` control.
- `create-open-deeplink` opens the same dialog from a workspace URL with `?create=1`.
- `create-submit` submits with `Start session` and shows a creating preview (`Creating session…`).
- `create-open-result` reaches the new session detail after the preview handoff.

## How to get to it (user POV)

- From Pipeline, Sessions, or Settings, choose `New session` in the workspace header.
- Open a workspace route with `?create=1` while signed in (composer deep-link).

## Driving it with control-wallie

Preconditions:

- Local Supabase is healthy with seed workspace `acme-corp` and completed onboarding (header shows `New session`, not `Resume setup`).
- `control-wallie doctor` passes.
- Browser is signed in: `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs sign-in --destination /w/acme-corp/sessions`.

- **Open composer (button).** Choose New session. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role button --name "New session"`. Dialog `Start a new session` appears.
- **Open composer (deep link).** On a separate pass (or after closing the dialog), visit the create deep link. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/sessions?create=1`. Dialog `Start a new session` appears without clicking `New session`.
- **Fill prompt.** Enter a nonempty prompt (required when no Linear URL is linked; `Start session` stays disabled until then). Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser fill --role textbox --name "Prompt" --value "Verify session create from control-wallie"`. Wait until repositories/stages finish loading if the dialog still shows `Loading repositories…`.
- **Submit and handoff.** Choose Start session. Run `... browser click --role button --name "Start session" --wait-for-url "/w/acme-corp/sessions/[0-9]+"`. The dialog closes; a `Creating session…` preview may appear briefly, then the URL must land on `/w/acme-corp/sessions/<number>` with session detail chrome (stage timeline or review bar). Do not treat the preview alone as proof of `create-open-result`.
- **Proof.** Capture `create-before.png` (composer open with Prompt filled) and `create-after.png` (session detail URL under `/w/acme-corp/sessions/<number>`) plus an ARIA snapshot of the detail page.

## Gotchas

- Incomplete onboarding replaces `New session` with `Resume setup`; that is an unmet precondition for this feature, not a harness failure.
- With no Linear URL, an empty Prompt keeps `Start session` disabled — always fill Prompt before submit.
- Failed or ambiguous creation may show `Retry creation` / `Open session` recovery controls — prove those only when intentionally testing recovery; the happy-path recipe stays on the page until the detail URL lands.
- Do not paste production credentials or attach private images in disposable verify runs.
