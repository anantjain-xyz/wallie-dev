# Performance telemetry

Wallie uses Vercel Speed Insights for LCP, CLS, and INP and Vercel Web Analytics for six sampled interaction timings. Both integrations render only when Vercel identifies the deployment as production. Preview deployments, local production-mode benchmarks, development, and tests neither load the production collectors nor emit custom events.

## Privacy contract

Page and Web Vital URLs are reduced to route templates before transmission. Unknown paths become `/redacted`; query strings and fragments are removed. Custom interaction events use the fixed name `wallie_interaction` and this field allowlist only:

| Field                    | Allowed values                                                                                                                    |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `action_name`            | `pipeline_to_sessions`, `sessions_to_detail`, `open_create_dialog`, `approve`, `reject`, `save_settings`                          |
| `route_from`, `route_to` | `/w/[workspaceSlug]`, `/w/[workspaceSlug]/sessions`, `/w/[workspaceSlug]/sessions/[sessionNumber]`, `/w/[workspaceSlug]/settings` |
| `duration_ms`            | Rounded non-negative milliseconds, capped at 300,000                                                                              |
| `outcome`                | `success` or `error`                                                                                                              |
| `device_class`           | `mobile` (<768 px), `tablet` (768–1023 px), or `desktop` (≥1024 px)                                                               |

Do not add workspace slugs, database or issue IDs, session numbers, titles, prompts, repositories, branches, emails, artifact text, feedback text, URLs, user-agent strings, or free-form error messages. New fields or actions require a privacy review and an update to the exact-payload tests.

## Sampling and retention

Custom interactions are sampled at 10%. A cryptographically random choice is written once to `sessionStorage`, so every eligible interaction in one browser-tab session makes the same choice. Core Web Vitals use the Vercel Speed Insights project sampling configuration.

Telemetry retention is 30 days. Raw event exports and secondary storage are prohibited. The Vercel project must use a retention window no longer than 30 days; if the plan cannot enforce that window, the Performance/Infra owner must disable collection until an equivalent deletion control is available.

## Ownership and operations

Performance/Infra owns the field allowlist, sampling, retention, Vercel project configuration, and quarterly privacy review. Product engineers own correct start/end placement at visible interaction boundaries. Navigation timings finish from target-page client boundaries that mount with real content, not from pathname changes or loading skeletons. Access is limited to repository and Vercel project owners.

Run `pnpm test:benchmark:interaction` against the fixed local Supabase seed to record request count, transferred bytes, click-to-visible-state for Pipeline → Sessions and Sessions → Detail, and the zero-idle-detail-prefetch assertion. The benchmark reports timings but deliberately has no millisecond threshold.

Route ceilings live in `config/route-budgets.json`. The shared/root ceiling applies to Next's `rootMainFiles`; each route ceiling applies to that route's diagnostic total after subtracting those separately budgeted shared bytes. CI prints the shared total and every route's total, current route contribution, and budget before failing. Established ceilings are immutable upper bounds in the checker, so normal changes can only keep or lower budgets; CODEOWNERS requires explicit repository-owner review of either file.
