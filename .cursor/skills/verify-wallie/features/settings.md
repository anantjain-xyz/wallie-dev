# Settings

Settings lets a workspace member open workspace configuration categories (Integrations, Workspace, Advanced) and inspect setup surfaces such as Verify setup without leaving the app shell.

## Sub-features

- `settings-open` shows the Settings heading inside the workspace shell.
- `settings-category` switches Integrations / Workspace / Advanced via category controls or `?category=`.
- `settings-verify-setup` reaches the Verify setup section used to confirm integration readiness.

## How to get to it (user POV)

- Choose `Settings` in workspace navigation.
- Open `/w/acme-corp/settings` or `/w/acme-corp/settings?category=integrations` while signed in.

## Driving it with control-wallie

Preconditions:

- Signed in to `acme-corp` via `control-wallie sign-in --destination /w/acme-corp/settings`.
- `control-wallie doctor` passes.

- **Open settings.** Visit Settings. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/settings`. Heading `Settings` is visible with workspace navigation still present.
- **Switch category.** Open Advanced. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/settings?category=advanced`. The Advanced category content is shown without leaving `/settings`.
- **Verify setup.** Move to the verify-setup section via in-page nav or Integrations category. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/settings?category=integrations` then snapshot. Copy related to setup verification is visible when that section is rendered.
- **Proof.** Capture `settings.png` and `settings.aria.txt` showing `Settings` and the active category.

## Gotchas

- Some settings write encrypted secrets; do not paste real production credentials into a disposable verify run.
- GitHub App env vars can be empty locally; missing GitHub config is a skip for install flows, not a Settings page failure.
