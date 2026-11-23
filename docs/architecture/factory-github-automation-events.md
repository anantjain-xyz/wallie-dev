# GitHub pull request automation events

A factory can trigger work from pull request lifecycle events in an installed repository. Wallie verifies the webhook signature and resolves the GitHub installation and base repository to one active factory before recording automation work.

| GitHub action                                   | Automation action                               |
| ----------------------------------------------- | ----------------------------------------------- |
| Opened, reopened, synchronize, ready for review | Opened, reopened, synchronize, ready for review |
| Closed without a merge                          | Closed                                          |
| Closed after a merge, with a merge commit       | Merged                                          |

The automation receipt retains the scoped delivery ID, provider PR ID, PR number, update time, base branch, head branch, and source SHA. One semantic event can record one occurrence per matching published rule. Redelivery returns the same receipt. A different delivery ID for the same semantic event creates a duplicate receipt without another occurrence.

Older snapshots and updates after a merge are stale. An unmerged closed PR can reopen. Contradictory snapshots at the same provider timestamp are retained as ambiguous, unless a verified merge establishes the terminal state. An accepted PR event creates a receipt even when every rule filters it out.

Wallie resolves causal sessions from exact, repository-scoped canonical and legacy PR links. A PR from an automation-owned session or workflow child is suppressed. A reserved same-repository Wallie branch without a resolved link is also suppressed while its ownership is uncertain. An unrelated fork using the same branch text does not acquire that identity.

The occurrence worker still checks the pinned rule, pause state, execution authority, and remaining capacity before admitting a session. The session prompt carries the trusted repository name, PR number, and source head SHA.

PR verification and canonical reconciliation keep their existing receipts and follow the same verified webhook regardless of automation eligibility. If automation capture fails, retry the original GitHub delivery.
