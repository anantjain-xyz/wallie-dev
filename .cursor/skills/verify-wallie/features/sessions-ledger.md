# Sessions ledger

The sessions ledger lists workspace sessions for `acme-corp`, lets a signed-in user search and filter them, and opens a session detail from a row.

## Sub-features

- `sessions-open` shows the Sessions heading and ledger for the workspace.
- `sessions-search` filters rows by the searchbox query.
- `sessions-status-filter` switches Active / All / Archived.
- `sessions-open-row` navigates into a session detail.

## How to get to it (user POV)

- After sign-in, choose `Sessions` in workspace navigation.
- Open `/w/acme-corp/sessions` directly while signed in.
- Use `control-wallie sign-in --destination /w/acme-corp/sessions`.

## Driving it with control-wallie

Preconditions:

- Local Supabase is healthy with seed data (`acme-corp`, sessions present).
- `control-wallie doctor` passes.
- Browser is signed in: `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs sign-in --destination /w/acme-corp/sessions`.

- **Open ledger.** Arrive on Sessions. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/sessions`. Heading `Sessions` is visible and navigation `Workspace navigation` includes `Sessions`.
- **Search.** Type a known seeded title fragment and submit the search form. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser fill --role searchbox --name "Search prompts, titles, or Linear IDs" --value "plan" --submit`. Matching rows remain; unrelated titles drop out after navigation settles. Filling without `--submit` does not filter.
- **Status filter.** Choose `All`. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role button --name "All"`. The ledger refreshes without error and still shows the Sessions heading.
- **Open a row.** Choose a session link. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role link --name "/^Open session /"`. The URL includes `/sessions/` and the detail chrome (stage timeline or review bar) appears.
- **Proof.** Capture the ledger. Run `... browser screenshot --path sessions.png` and `... browser snapshot --aria --path sessions.aria.txt` from `/w/acme-corp/sessions`. Artifacts show `Sessions` and at least one session row.

## Gotchas

- Without seed data the ledger is empty; empty is not a substitute for row-open proof.
- Search only applies after the form submits (Enter or the visually hidden `Search` button). Filling the box alone does not filter rows.
- Signing in requires Supabase Auth admin `generate_link`; a down Auth API fails `sign-in` and blocks this feature.
