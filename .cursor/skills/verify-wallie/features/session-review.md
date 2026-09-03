# Session review

Session review lets an authorized user approve an awaiting-review artifact to advance (or archive), or request changes with feedback that queues a rerun of the same stage.

## Sub-features

- `review-open` opens a session that is awaiting review.
- `review-approve` chooses Approve & advance or Approve & archive.
- `review-request-changes` opens the Request changes dialog, enters feedback, and queues a rerun.

## How to get to it (user POV)

- From Sessions or Pipeline, open a session whose stage status is awaiting review.
- Open `/w/acme-corp/sessions/<number>` for a seeded awaiting-review session while signed in.

## Driving it with control-wallie

Preconditions:

- Local Supabase seed includes at least one `awaiting_review` session the signed-in user may approve.
- `control-wallie doctor` passes and `sign-in` succeeded.
- For real stage advancement after approve, `pnpm worker` is running; without it, prove the UI acknowledgment only and note the worker gap.

- **Open review.** Navigate to an awaiting-review session detail. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/sessions/<number>` (use a real seeded number). Review actions `Approve & advance` or `Approve & archive`, plus `Request changes`, are visible.
- **Request changes.** Choose `Request changes`. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role button --name "Request changes"`. Dialog `Request changes` appears with textbox `Feedback for Wallie`.
- **Submit feedback.** Fill feedback and queue. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser fill --role textbox --name "Feedback for Wallie" --value "Needs clearer acceptance criteria"` then `... browser click --role button --name "Queue rerun" --wait-hidden`. The dialog closes (`Queue rerun` becomes hidden) and the session shows a rerun / in-progress style state (worker required for full progress). Use `--wait-for-text` when the result is a visible status string rather than a disappearing control.
- **Approve path.** On another awaiting-review session, choose the approve button label shown (`Approve & advance` or `Approve & archive`). Run `... browser click --role button --name "Approve & advance" --wait-for-text "Review approved."` (or the archive variant with the same wait). Wait for that success state before capturing proof; an optimistic UI change can roll back if `/phase-action` fails.
- **Proof.** Screenshot before and after the action (`review-before.png`, `review-after.png`) plus an ARIA snapshot showing the new status text.

## Gotchas

- Button labels differ on the terminal stage (`Approve & archive` vs `Approve & advance`).
- Older Playwright specs that click `Request changes and rerun` are stale; the live control is `Request changes` then `Queue rerun`.
- Approver lists on pipeline stages can hide Approve for unauthorized users; use the seed owner `anant@example.com`.
