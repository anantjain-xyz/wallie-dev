# Qualify Linear and GitHub conversation continuity

Use the deterministic fixture to check the complete Wallie journey, then
repeat the provider operations with isolated real accounts. Use an exclusive
disposable Wallie database for each run. Outbound worker claims are scoped to a
provider across the database.

## Deterministic qualification

Apply this checkout's migrations to a fresh local Supabase project. Install
Chromium with the repository's Playwright version.

```bash
pnpm exec playwright install chromium
pnpm check:factory-runtime --workdir /path/to/disposable-supabase --m13
```

The launcher runs a production Next.js build with isolated credentials and
accepts only loopback Supabase and provider transports. Run it on an empty
connector database. Use `WALLIE_M13_PROOF_DIR` to retain the Chromium captures in
a chosen absolute directory.

| Journey             | Evidence                                                                                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub intake       | Signed label delivery, exact and semantic replay, one linked session and first job, and verified human attribution                                                                                                                   |
| GitHub conversation | Original and edited comments, an older delivery arriving late, and an actor revoked before a new delivery                                                                                                                            |
| Linear intake       | One canonical issue across repeated or reordered pages, verified creator, and denial when the creator is outside scope                                                                                                               |
| Wallie review       | Two signed-in humans discuss an exact Linear artifact. A change request retains the source and queues one successor. The old review URL becomes stale, and the exact current URLs record the approver, artifact, version, and digest |
| Outbox              | One accepted provider write with a lost response, an observation of the original reply, and the same receipt and deadline through settlement                                                                                         |

The browser verifies that a user from another workspace cannot read the
conversation or approve the linked artifact. It opens the review URLs from
provider replies.

## Real Linear account

1. Save a key for the approved Linear organization in a disposable Wallie
   workspace. In **Settings → Integrations → Connector resources**, verify and
   map the approved team or project.
2. Link the test issue creator's Linear ID to the signed-in Wallie human.
   Enable discovery for the issue's workflow state and a unique test label.
   Enable linked comments. For a status check, configure exact source and
   destination workflow state IDs on the approved team.
3. Create one synthetic issue in the mapped resource with the test label.
   Run a scoped discovery sweep twice. Check that both scans refer to the same
   Linear issue UUID and Wallie session, with one initial job.
4. Open the linked session. Start an artifact discussion as the source actor
   and reply as a second authorized Wallie human. Request changes, then
   publish a revised artifact on that same session. Open the provider's new
   review link. Approve the displayed artifact as the authorized human.
5. Verify the progress, review, and final replies on the original issue. For
   opt-in status changes, verify the original state span closes and the
   destination span opens after final approval.
6. Move the synthetic issue to recoverable trash and retire its unique label.

Linear sends the review link to the issue. The signed-in discussion, change
request, and decision happen in Wallie.

## Real GitHub account

1. Use the existing `anantjain-xyz/wallie-dev` smoke repository. Create a unique
   fixture head from an approved non-main test base and open one synthetic
   draft PR against that base.
2. Verify the existing GitHub App installation and map that repository in the
   disposable Wallie factory. Link the label actor and commenter to their
   verified Wallie human identities. Configure the unique fixture label for
   pull request intake using the factory's published grant.
3. Apply the label as the linked human. Record the immutable repository, pull
   request, and issue timeline IDs. Add and edit a human reply on the draft.
   Verify the edit stays in the same Wallie conversation.
4. If the installed App lacks the relevant webhook subscription, build the
   replay from the recorded provider objects. Sign the exact payload and
   deliver it to local `/api/github/webhooks` with the isolated webhook secret.
   Repeat the same delivery, then deliver the older comment state under a
   new delivery ID. Check that the initial job and original and edited
   conversation entries appear once.
5. Open the exact Wallie review URL published on the PR. Approve the current
   artifact as an authorized human. Verify the App's final reply in the same
   PR conversation.
6. Close the synthetic draft and clear its unique label. Keep the fixture head
   and PR history for evidence.

## Recover an accepted reply

Wrap only the test provider request. Let one comment write reach the approved
issue or PR, capture its provider reply ID, then discard the successful
response before Wallie settles the delivery. The history should show
**Outcome unknown**. Select **Check provider status** on that receipt and run
maintenance again. Verify the worker uses observation, the receipt retains
its original deadline, and the original reply ID settles with no second
provider write.
