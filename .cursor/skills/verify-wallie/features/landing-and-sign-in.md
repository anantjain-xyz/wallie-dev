# Landing and sign-in

Landing and sign-in let an unauthenticated visitor see Wallie's product pitch, open the email sign-in flow, request a magic link or OTP, and get redirected to login when they hit a protected workspace URL.

## Sub-features

- `landing-hero` shows the Wallie brand, headline, and primary CTA on `/`.
- `landing-cta` navigates from `Get started` (or header `Sign in`) to `/login`.
- `login-form` shows the Work email field and `Send magic link` submit.
- `login-request` submits an email and reaches the check-email / code state when Auth is healthy.
- `protected-redirect` sends unauthenticated `/w/...` visits to `/login` with a `next` param.

## How to get to it (user POV)

- Open `/` while signed out.
- Choose the `Get started` link in the hero, or `Sign in` in the header nav.
- Open `/login` directly.
- Open a protected path such as `/w/acme-corp/sessions` while signed out.

## Driving it with control-wallie

Preconditions:

- `control-wallie doctor` passes against a logged-out instance.
- No Supabase session cookies are present for the verification browser profile.
- Magic-link submit (`login-request`) additionally requires a healthy local Supabase Auth API.

- **Open landing.** Visit home. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /`. The page shows link `Wallie home`, heading `Turn a task into a pull request you can trust`, link `Get started`, and header link `Sign in`.
- **Use primary CTA.** Choose `Get started`. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role link --name "Get started"`. The URL becomes `/login` and heading `Sign in to Wallie` is visible with textbox `Work email`.
- **Use header sign-in.** Return to landing first (the previous step leaves the shared page on `/login`, where header `Sign in` does not exist). Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /` then `... browser click --role link --name "Sign in"`. The URL becomes `/login` with the same login heading and Work email field.
- **Fill email.** Enter a work address. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser fill --role textbox --name "Work email" --value "anant@example.com"`. The field shows that value on the live page and `Send magic link` remains available.
- **Request magic link (Auth up).** Choose `Send magic link`. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser click --role button --name "Send magic link" --wait-for-text "Check your email"`. When Auth succeeds, capture that check-email / code state immediately: `... browser screenshot --path login-request.png` and `... browser snapshot --aria --path login-request.aria.txt`. When Auth is down, treat submit failure as a skip for `login-request` and still prove `landing-hero` / `landing-cta` / `login-form`.
- **Protected redirect.** Open a workspace URL signed out. Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /w/acme-corp/sessions`. The URL becomes `/login?next=%2Fw%2Facme-corp` (workspace layout redirects with the workspace base path, not the deeper sessions path) and heading `Sign in to Wallie` is visible.
- **Proof.** Capture landing and the login form (not a substitute for `login-request`). Run `node .cursor/skills/verify-wallie/scripts/control-wallie.mjs browser goto /` then `... browser screenshot --path landing.png` and `... browser snapshot --aria --path landing.aria.txt`. Repeat on `/login` with `login.png` / `login.aria.txt`. Artifacts show Wallie branding plus `Get started` or the Work email field.

## Gotchas

- Authenticated users hitting `/` redirect into a workspace home or onboarding (`/onboarding/workspace` when they have no workspace); doctor and landing recipes assume a signed-out browser.
- There is no password field. Do not look for password login.
- Do not click `Sign in to Wallie` on the landing page — that heading exists only on `/login`. Landing CTAs are `Get started` and header `Sign in`.
- Browser commands share one live page until `stop`. Fill then `Send magic link` submits the filled form; do not `goto /login` between those two steps.
- `Send magic link` against a dead Auth URL fails the network call; that does not invalidate landing or login-form proof.
- Seed sign-in for authenticated features uses `control-wallie sign-in`, not the public email form.
