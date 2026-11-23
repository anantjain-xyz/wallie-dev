# Parallel workflow branches

A branch occurrence freezes the exact accepted checkpoint from its graph input or delegated parent, and a named slot for each declared child. Every child receives its own pinned profile, session, sandbox, and private output ref. All slots use the frozen parent source. A later accepted run blocks a still-unopened fork, even when both runs produced the same commit.

```mermaid
flowchart LR
  Parent[Accepted parent checkpoint] --> Fork[Branch manifest]
  Fork --> Required[Required child]
  Fork --> Optional[Optional child]
  Required --> Receipt[Exact output receipts]
  Optional --> Receipt
  Receipt --> Ready[Join readiness]
```

Node and Workerd maintenance advance due branch groups. Each scheduler transaction locks one root and observes terminal child attempts. Required slots get first use of capacity. Within each tier, slots that have waited longer get the next attempt. A group waiting on capacity yields to other roots. Child admission and attempts share the root’s existing grant and budget checks.

An unstarted reservation or estimated usage can leave another slot pending. Once exact attempts or measured usage exhaust the pinned budget, the remaining slots record a terminal admission blocker.

| Join readiness     | Evidence                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------- |
| Pending            | A declared slot still needs admission, execution, or review.                                                  |
| Ready              | Every slot retained an approved child checkpoint.                                                             |
| Required blocked   | A required child failed, was canceled, or cannot be admitted under a lifetime limit.                          |
| Optional failure   | Required children succeeded and at least one optional slot failed, was canceled, or reached a lifetime limit. |
| Paused or canceled | The root lifecycle controls further work.                                                                     |

A successful receipt identifies the named slot, exact child job and run, frozen input commit, adopted checkpoint, and retained output ref. Approval stays tied to the exact child artifact. An unstarted failure or cancellation has a terminal job receipt without a checkpoint. Pause retires the old attempt, and a valid resume can start a fresh attempt on the same job. Root branches of a triage workflow use the approved task and retain its acceptance criteria.

## Join branch outputs

A factory manager submits the branch group, workflow generation, exact parent checkpoint run, and selected outcome IDs. Every required slot must supply a successful output. Optional slots must be terminal and can be omitted. Within the same workflow generation, replaying the request returns its original join, job, and run.

```mermaid
flowchart LR
  Selection[Named branch outputs] --> Receipt[Sealed join receipt]
  Receipt --> Merge[Verify and merge retained Git inputs]
  Merge -->|Conflict| Report[Private conflict report]
  Merge --> Validate[Validate exact commit and tree]
  Validate -->|Passed| Adopt[Atomic checkpoint and artifact adoption]
  Validate -->|Blocked| Keep[Keep the accepted parent checkpoint]
  Adopt --> Review[Parent artifact review]
```

- **Source.** The worker fetches each frozen Git input and verifies its commit before merging. The parent generation and checkpoint run are checked again at adoption, including when a newer checkpoint has the same commit.
- **Validation.** The pinned parent delivery policy defines which evidence must pass. The worker preserves the parent’s frozen validation order. For a specification checkpoint, compatible plans from the selected branches supply the required checks in their original relative order. Validation runs against the joined commit and tree in a separate sandbox without GitHub or model credentials. The worker prepares Node tooling and installs dependencies from supported repository lockfiles before replaying the plan. Other toolchains can include their setup in the frozen plan. The branch selection response exposes the 48 MiB packed-source limit before submission.
- **Publication.** The existing checkpoint publisher records the exact integrated commit and tree, advances the parent checkpoint, and creates the parent review artifact in one transaction. Downstream nodes can read that accepted checkpoint after adoption.
- **Blocked joins.** Conflicts retain a private, immutable report for the exact join attempt. Missing inputs, stale ownership, and failed validation keep the current parent checkpoint. Each child approval applies to its own artifact. The joined artifact requires its own parent approval.

## Deliver a repository set

A compiled `repositorySets` entry assigns named branch edges to each secondary repository and pins its exact writer grant revision. Each repository needs a required branch. Unassigned branches use the primary repository. The worker observes the first secondary base under its current repository-specific grant. Later forks use the exact accepted secondary head and retained ref.

Join admission records an independent delivery obligation for each secondary repository. The primary checkpoint creates the parent review artifact. For each secondary repository, a dedicated attempt integrates its selected branch outputs and replays compatible frozen branch plans in a credential-free sandbox. The parent delivery policy sets the evidence requirements. The worker retains the exact validation run, joined tree, and checkpoint.

| Delivery status | Meaning                                                                          |
| --------------- | -------------------------------------------------------------------------------- |
| `pending`       | The join still needs its first accepted checkpoint.                              |
| `partial`       | The primary is accepted and at least one secondary delivery remains outstanding. |
| `blocked`       | The primary failed or delivery is blocked before any checkpoint was accepted.    |
| `adopted`       | All declared repositories have accepted checkpoints. The graph can continue.     |

Read a repository set with `GET /api/sessions/{sessionId}/workflow-join?joinId={joinId}`. The response includes each secondary base, validated output, validation run, and delivery status. The workflow lifecycle state remains visible while paused or canceled. Resume gives an unfinished validation a fresh attempt against the same repository base. A sealed checkpoint resumes publication without another validation run.

Publication verifies the exact retained ref in each repository. A transient failure leaves the sealed checkpoint available for a fresh lease. The next claimant checks the remote ref before writing. A changed repository head, revoked writer, or incompatible remote ref blocks only that repository. The ledger records when a remote ref still needs reconciliation. Published repositories retain their adopted checkpoints while another repository recovers.

## Review a joined checkpoint

A graph can place a `review` node immediately after a join. For a repository set, review starts after every repository adopts its checkpoint. The review pins the accepted primary checkpoint, a factory reviewer prompt revision, a set of rule IDs, and an optional repair declaration.

```mermaid
flowchart LR
  Join[Adopted join] --> Review[Exact commit review]
  Review -->|Pass| Gate[Independent workflow gate]
  Review -->|Eligible findings| Repair[Reserved repair job]
  Repair --> Validate[Fresh validation and checkpoint adoption]
  Validate --> Review
  Review -->|Ineligible or repeated findings| Escalate[Recorded escalation]
```

- **Review input.** The permit pins the checkpoint run, commit, tree, repository, and reviewer prompt. The worker verifies the retained ref and reads the exact Git diff with read-only access. It verifies required validation receipts before inference.
- **Inference budget.** Node and Workerd share the one-use review permit. The OpenAI adapter uses the inherited parent credential, disables tools, and checks tokens and spend before generation. The bounded charge remains reserved if the provider response is lost.
- **Repair.** The declaration records a unique `edgeId`, a `maxRepairs` value from 1 through 8, and the `eligibleRuleIds` subset. Admission reserves one job and its root budget together. Replays return the same job. A repeated rule and path escalates even when the finding moves to another line.
- **Validation and approval.** The repair starts from the reviewed checkpoint and receives the saved findings as untrusted input. Adoption requires fresh evidence on the repaired commit and tree. The repaired artifact keeps the original human blocking requests and requires its own independent approval. Existing PR readiness observes the current delivery state.

## Drafts and published workflows

Open **Workflows** under **Configure** to edit the graph. The graph and ordered list use the same steps, transitions, and policies. **Pipeline** opens the operational board, and **Serial pipeline settings** opens the stage editor.

- **Save draft** compiles the graph and checks the displayed draft, published activation, and factory definition. A conflict keeps the editor’s local changes.
- **Publish draft** activates the exact saved revision. When the factory definition changes, **Rebase and save draft** compiles the graph against the new definition.
- Choose a published workflow in **New session**. Session creation pins that activation with its admission receipt. The final preparation checkpoint schedules the first workflow occurrence. Later publications affect future selections.
