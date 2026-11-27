# Manual Bombadil review check

Run this from the repository root in a disposable Linux development VM with local Docker Engine
28+ at `/var/run/docker.sock`,
Supabase CLI, `psql`, `socat`, `ip`, unprivileged user/network namespaces, and Chrome or
Chromium. Install Wallie's usual dependencies with `pnpm install --frozen-lockfile`.
Ports 55320–55329 must be free on the Docker host. This does not touch the normal
`wallie-dev` Supabase project or use your `.env` files.

Download the [Bombadil v0.8.0 browser driver](https://github.com/antithesishq/bombadil/releases/tag/v0.8.0)
outside the checkout. For Linux x86-64:

```bash
tool="$(mktemp -d)"
curl -fsSL https://github.com/antithesishq/bombadil/releases/download/v0.8.0/bombadil-x86_64-linux -o "$tool/bombadil"
printf '%s  %s\n' d9d1d2832cb23c874744a4f20526d2064ce8571c31f8ecd01ddf8e1c44da4814 "$tool/bombadil" | sha256sum -c -
chmod +x "$tool/bombadil"
BOMBADIL="$tool/bombadil" CHROME=chromium bash scripts/bombadil-review/run.sh
```

The launcher uses the Wallie source at `HEAD` and takes a few minutes after
the Supabase images are cached. It warms Sessions and waits for the exact review
before starting the worker's decision wait and the bounded 40-second browser trace.
Use `approve`, `reject`, or `negative` as an argument
to run just one case. The negative control deliberately expects two new Build runs
instead of one. Running `negative` alone preserves Bombadil's exit code 2; `all`
expects that code and the named property violation. A run without an accepted exact review and
settled post-decision reload is not a positive pass.

**What's real:** local Supabase Auth, RLS, Next.js review UI and request, the
approval/feedback transactions, the job claim and pipeline processor, Storage and
artifact adoption. The fixture enables checkpoint publication only in the
disposable DB and seeds a retained Plan v1 before tracing. A scoped, read-only
SQL query checks the exact Plan v1 receipt or feedback batch, run count and
current artifact. Approval produces Build v1;
rejection produces Plan v2. The browser checks the persisted stage and version
against the review heading after a real reload.

**What's faked:** the synthetic reviewer signs in before tracing. The existing
release-test transport uses a local Git repo and fake provider/agent output, not a
live integration or the worker daemon. Supabase ports publish on host loopback
only. The browser and app have only loopback access in their namespace, with
tunnels to that disposable API and DB. Chrome uses a
throwaway profile; the fixture uses fallback fonts. The spec only offers the
review decision, fixed rejection text, reload, and navigation between this session
and Sessions. It does not run Bombadil's default generators.

**Inspecting results:** the launcher prints the revision, durations, transition
counts and path to private `.wallie/bombadil-review.*` results. It removes the
fixture database and browser profile. Use the same pinned binary to inspect
individual states (the trace includes screenshots), for example:

```bash
"$tool/bombadil" trace --json --state 0..3 "$results/negative.bin"
"$tool/bombadil" browser inspect "$results/negative.bin"
```

Set `results` to the printed directory and use `firstViolationState` from
`negative.json` to jump to the failure. Do not publish raw traces. Inspection is
offline; a fresh invocation reseeds the DB and samples new actions.
Bombadil's best-effort `--reproduce` needs the original starting state, spec and
browser options; an old trace alone cannot replay the disposed database or login.
If a forced kill prevented cleanup, run `supabase stop --project-id <printed-project-id> --no-backup`
for the printed fixture project, then remove its same-named Docker network if it remains.
For optional static checking, use the v0.8.0 release's `bombadil-npm-package.tar.gz`
declarations in a scratch directory and TypeScript's `--allowJs --checkJs --strict`
on the spec with its generated scenario JSON.

Keep this manual. It varies action order around one durable review loop;
Playwright still owns scripted browser scenarios and pgTAP owns SQL-level
transaction and authorization coverage. This is not a CI gate.
