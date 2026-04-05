import Link from "next/link";

import { StatusChip } from "@/components/shared/status-chip";
import { loginPath, signupPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed: "The sign-in callback did not complete. Start the flow again.",
  auth_confirmation_failed:
    "The email link could not be confirmed. Request a fresh link and try again.",
  email_sign_in_failed: "Wallie could not send that magic link. Check the email and try again.",
  password_auth_failed: "Dev password sign-in failed. Check credentials and try again.",
  invalid_provider: "That sign-in provider is not supported on this route.",
  oauth_sign_in_failed: "Wallie could not start that provider sign-in flow.",
} as const;

const authStatusMessages = {
  check_email:
    "Check your inbox for a secure sign-in link. It will continue into your workspace flow.",
  signed_out: "Your session has been closed.",
} as const;

type AuthEntryPanelProps = {
  errorCode?: string | null;
  mode: "login" | "signup";
  next: string;
  statusCode?: string | null;
};

function buildOauthHref(provider: "github" | "google", mode: "login" | "signup", next: string) {
  const params = new URLSearchParams({
    mode,
    next,
    provider,
  });

  return `/auth/oauth?${params.toString()}`;
}

export function AuthEntryPanel({ errorCode, mode, next, statusCode }: AuthEntryPanelProps) {
  const isSignup = mode === "signup";
  const alternateHref = isSignup ? loginPath(next) : signupPath(next);
  const alternateLabel = isSignup ? "Open Login" : "Create Account";
  const errorMessage = errorCode
    ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
    : null;
  const statusMessage = statusCode
    ? authStatusMessages[statusCode as keyof typeof authStatusMessages]
    : null;

  return (
    <section className="ui-panel w-full p-6 sm:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <StatusChip tone="ready">{isSignup ? "Create Access" : "Sign In"}</StatusChip>
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-balance text-foreground sm:text-[2.2rem]">
              {isSignup ? "Create Your Wallie Identity" : "Enter Your Workspace"}
            </h1>
            <p className="max-w-2xl text-sm leading-6 text-muted">
              {isSignup
                ? "Choose Magic Link or OAuth, then continue into first-workspace setup under Supabase Auth."
                : "Choose Magic Link or OAuth. Wallie routes you to your workspace or first-run onboarding."}
            </p>
          </div>
        </div>

        <Link href={alternateHref} className="ui-button">
          {alternateLabel}
        </Link>
      </div>

      {statusMessage ? (
        <div
          aria-live="polite"
          role="status"
          className="mt-6 rounded-[6px] border border-warning/20 bg-warning-soft px-4 py-3 text-sm leading-6 text-warning"
        >
          {statusMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div
          aria-live="polite"
          role="status"
          className="mt-6 rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm leading-6 text-danger"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <form action="/auth/email" method="post" className="ui-subpanel p-5">
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="next" value={next} />

          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted">Magic Link</p>
            <h2 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
              Email First, Password Never
            </h2>
            <p className="text-sm leading-6 text-muted">
              Wallie sends a single-use sign-in link and returns you to the exact workspace path you
              came from.
            </p>
          </div>

          <label className="mt-5 block text-sm font-semibold text-foreground">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              inputMode="email"
              placeholder="name@company.com…"
              spellCheck={false}
              className="ui-input mt-2 text-base"
            />
          </label>

          <button type="submit" className="ui-button-primary mt-5">
            {isSignup ? "Send Sign-Up Link" : "Send Sign-In Link"}
          </button>
        </form>

        <div className="ui-subpanel p-5">
          <p className="text-[11px] font-medium text-muted">OAuth</p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-foreground">
            Continue With Your Provider
          </h2>
          <p className="mt-3 text-sm leading-6 text-muted">
            Supabase Auth handles identity. Workspace access still comes from `workspace_members`
            and RLS after the session is established.
          </p>

          <div className="mt-5 grid gap-3">
            <Link href={buildOauthHref("google", mode, next)} className="ui-button">
              Continue with Google
            </Link>
            <Link href={buildOauthHref("github", mode, next)} className="ui-button">
              Continue with GitHub
            </Link>
          </div>

          <p className="mt-5 text-xs leading-6 text-muted">
            If your session already exists, Wallie will skip this screen and send you straight to
            the correct workspace entry route.
          </p>
        </div>
      </div>

      {process.env.NODE_ENV === "development" && (
        <form action="/auth/password" method="post" className="ui-subpanel mt-6 p-5">
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="next" value={next} />

          <div className="space-y-2">
            <p className="text-[11px] font-medium text-muted">Dev Only</p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Password Auth
            </h2>
            <p className="text-sm leading-6 text-muted">
              Development-only email + password sign-in. Not available in production.
            </p>
          </div>

          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-foreground">
              Email
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="dev@localhost.com…"
                className="ui-input mt-2 text-base"
              />
            </label>
            <label className="block text-sm font-semibold text-foreground">
              Password
              <input
                type="password"
                name="password"
                required
                minLength={6}
                autoComplete="current-password"
                placeholder="Min 6 characters…"
                className="ui-input mt-2 text-base"
              />
            </label>
          </div>

          <button type="submit" className="ui-button-primary mt-5">
            {isSignup ? "Dev Sign Up" : "Dev Sign In"}
          </button>
        </form>
      )}
    </section>
  );
}
