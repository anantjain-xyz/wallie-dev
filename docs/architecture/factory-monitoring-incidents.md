# Sentry monitoring incidents

Wallie turns a signed Sentry issue alert for a successful guarded deployment into a reviewable incident session. The incident retains the deployment, exact source revision, reviewed head, Sentry issue and event, and the session that produced the delivery.

## Configure a binding

- Use an approved Wallie deployment source for the factory's current repository.
- As a factory manager, send an approve command to the factory's monitoring bindings endpoint. Supply a new binding ID, the deployment source ID, the Sentry integration installation UUID, the numeric project ID as a string, the integration Client Secret, and a suppression window from 60 to 86,400 seconds.
- Send Sentry issue alerts to the signed webhook for the returned binding ID. Instrument the deployment with the `wallie_delivery_command` event tag set to the Wallie delivery command UUID. Set the Sentry release to the full deployed commit SHA and the environment to the exact deployment environment.
- Read active bindings with the manager endpoint. Use the disable command with the binding ID to stop ingress and prevent its queued incidents from starting. Approve a fresh binding to change configuration or replace a secret.

- Manager endpoint `/api/workspaces/{workspaceId}/factories/{factoryId}/monitoring-bindings`
- Webhook endpoint `/api/monitoring/sentry/{bindingId}`

## Admission and recovery

- The webhook checks the signature over the received bytes and the signed installation and project. It retains only the normalized evidence and a digest.
- A bound environment, command, and source SHA must match the current authenticated deployment observation. A stale success, a different release, or an unknown deployment cannot queue work.
- Identical event IDs replay the original receipt. Additional events for the same Sentry issue and deployment share the admitted window even after replacing a signing secret. A fresh event can open a new incident when an earlier queued incident lost deployment authority. Ingress allows 30 unique signals per monitoring scope and 100 per factory per minute, with up to 24 queued incidents per factory.
- Node and Workerd admit work from the same durable queue. A factory can have up to four active incident sessions. The worker rechecks the current deployment and approved budget and agent authority. Pending incidents expire after 30 minutes and authority conflicts have at most five attempts.
- Incident sessions use the factory's configured pipeline. Guarded delivery still requires an explicit authorized command and its existing review gates. A deployment produced by an incident or its delegated work cannot open another incident.

[Sentry issue-alert webhooks](https://docs.sentry.io/integrations/integration-platform/webhooks/issue-alerts/) · [Sentry webhook signatures](https://docs.sentry.io/integrations/integration-platform/webhooks/#sentry-hook-signature)
