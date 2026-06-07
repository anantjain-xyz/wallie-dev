# Security Policy

We take the security of Wallie and of anyone self-hosting it seriously. Thank you for helping keep it safe.

## Reporting a vulnerability

**Please do not report security issues through public GitHub issues, discussions, or pull requests.**

Instead, report privately using one of:

- **GitHub Security Advisories** — [open a private report](https://github.com/anantjain-xyz/wallie-dev/security/advisories/new) (preferred).
- **Email** — anant90@gmail.com. Use a subject line beginning with `[SECURITY]`.

Please include:

- a description of the issue and its impact,
- steps to reproduce (proof-of-concept if possible),
- affected version/commit and environment,
- any suggested remediation.

We'll acknowledge your report, keep you updated on progress, and credit you (if you wish) once a fix ships. Please give us a reasonable window to release a fix before any public disclosure.

## Scope

In scope:

- The application code in this repository (web app, API route handlers, worker).
- Authentication/authorization and tenant isolation (Supabase RLS, workspace scoping).
- Handling of secrets and integration credentials.

Out of scope:

- Vulnerabilities in third-party services (Supabase, Vercel, GitHub, Linear, model providers) — report those to the respective vendors.
- Issues that require a compromised host, physical access, or a malicious workspace admin acting within their own workspace.
- The hosted instance at `wallie.dev`'s infrastructure configuration (report app-level bugs here; infra concerns can go to the email above).

## Notes for self-hosters

Wallie executes agent-authored code inside sandboxes and stores integration credentials. Operate it with that in mind:

- **`WALLIE_ENCRYPTION_KEY`** is the master key for AES-256-GCM encryption of workspace secrets and per-user agent credentials at rest. Generate it with `openssl rand -hex 32`, store it only in your platform's secret manager, and never commit it. Rotating it requires re-encrypting existing stored values.
- **Never commit `.env.local`** or any real credentials. Everything matching `.env*` (except `.env.example`) is gitignored — keep it that way. `*.pem` private keys are gitignored too.
- **Use the service-role key (`SUPABASE_SECRET_KEY`) only server-side.** Never expose it to the browser; client code uses the publishable/anon key.
- **GitHub webhooks are signature-verified** against `GITHUB_WEBHOOK_SECRET` — set a strong value and keep it in sync with your GitHub App.
- **Treat workspace-supplied content as untrusted** (e.g. Linear issue text, the session prompt) when it flows into a model prompt. A `sanitizeUntrusted()` helper exists in `src/lib/pipeline/prompt-safety.ts`, but it is **not currently wired into the prompt path** — `processPipelineJob()` renders the session prompt as-is. If you extend prompts with untrusted input, apply that helper (or equivalent data-boundary markers) yourself; don't assume the boundary is already enforced.
- Keep dependencies and your Supabase project up to date.
