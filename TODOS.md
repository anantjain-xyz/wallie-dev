# TODOS

## Pipeline Dashboard — Phase 2

### PM/EM role mapping

- **What:** Add a `role` field to `workspace_members` (e.g., pm, designer, engineer, em) so the pipeline can identify who to escalate to and who can approve at each phase.
- **Why:** Current member model is just owner/admin/member/agent. Escalation flow needs to know who the EM is. Approval flow should eventually gate on PM/designer roles.
- **Phase 1 workaround:** Store EM Slack user ID as a `workspace_secret` key. Hardcode the escalation target.
- **Effort:** S (human: ~2h / CC: ~10min)
- **Priority:** P2
- **Depends on:** Nothing. Can be done independently.

### Slack App install/admin surface

- **What:** Build an admin settings page for Slack integration: workspace binding, channel selection, token rotation, scope failure handling, and recovery UX.
- **Why:** Phase 1 uses manual Slack App install + env vars. This doesn't scale to multi-workspace and makes token rotation a manual process.
- **Phase 1 workaround:** Manual Slack App creation, env var configuration, and workspace_secrets for tokens.
- **Effort:** M (human: ~1 week / CC: ~30min)
- **Priority:** P2
- **Depends on:** Pipeline Dashboard (Phase 2)

### PM preference learning / spec templates

- **What:** Learn from PM approval patterns to generate better specs over time. Build spec templates from approved specs.
- **Why:** The 10x version of Wallie compounds. Each spec should be better than the last because it has learned from what PMs accept.
- **Phase 1 workaround:** None needed. Feature is additive.
- **Effort:** M (human: ~1 week / CC: ~30min)
- **Priority:** P3
- **Depends on:** 5-10 real approvals (cold start problem). Cannot build until there's enough approval data to learn from.
