# Pipeline board

The pipeline board shows workspace sessions organized by pipeline stage columns so a signed-in user can scan work in flight and open a session from the board.

## Sub-features

- `pipeline-open` shows the Pipeline heading and board region.
- `pipeline-filter` uses pipeline filter controls without leaving the page.
- `pipeline-open-session` opens a session from a board card/link.

## How to get to it (user POV)

- Choose `Pipeline` in workspace navigation.
- Open `/w/acme-corp` while signed in.
- Use `control-wallie sign-in --destination /w/acme-corp`.

## Driving it with control-wallie

Preconditions:

- Local Supabase is healthy with seed data for `acme-corp`.
- `control-wallie doctor` passes.
- Browser is signed in to `/w/acme-corp`.

- **Open board.** Visit the workspace root. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp`. Heading `Pipeline` and region `Pipeline board` are visible.
- **Use filters.** Focus pipeline filters. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser snapshot --aria --path pipeline-filters.aria.txt` after interacting with `Pipeline filters` controls if present. The board region remains on the page.
- **Open session.** Choose a session open link. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role link --name "/^Open session /"`. The session detail URL loads under `/w/acme-corp/sessions/`.
- **Proof.** Capture the board. Run `... browser screenshot --path pipeline.png` and `... browser snapshot --aria --path pipeline.aria.txt`. Artifacts identify Wallie, `Pipeline`, and `Pipeline board`.

## Gotchas

- The board can be empty on a fresh workspace without seed; seed before claiming card-open proof.
- `pnpm worker` is not required to view the board, only to advance jobs behind the scenes.
