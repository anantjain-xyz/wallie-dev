# Adopt a reviewed factory improvement

A workspace owner or admin adopts the exact tested configuration from its merged GitHub PR. The Improvements detail links the PR, both benchmark suites, and the resulting activation receipt.

| Proof         | Bound to adoption                                                                                                                                     |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub        | Numeric repository, PR, frozen base and head commits, merged tree, and latest exact-head approval from an independent human with current write access |
| Configuration | Exact hosted definition bytes recompiled with the current factory catalog and matched to the tested revision and digest                               |
| Qualification | Current targeted and held-out results, exact comparison identities, and the active definition used as their baseline                                  |
| Decision      | Current human Wallie manager, previous and new activation numbers, and both immutable configuration revisions                                         |

- Review the verified draft in GitHub. Mark it ready, obtain an eligible approval, and merge the reviewed head. In Wallie, select **Adopt configuration**, then **Verify GitHub and adopt**.
- Adoption checks the current factory head and qualification in the same transaction that records the receipt and appends the tested revision. A competing activation or withdrawn evidence requires a new decision.
- Resolve an active routing canary through its existing controls before adopting a separate improvement. New admissions use the accepted definition and eligible routing. Existing sessions keep their recorded revision and review state.
- A later routing rollback can restore an adoption-backed routing activation after a fresh candidate smoke test and current qualification checks. The restored activation retains the original adoption receipt as its routing evidence.
