import Link from "next/link";

import { StatusChip } from "@/components/shared/status-chip";
import { loginPath, signupPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed:
    "The sign-in callback did not complete. Start the flow again.",
  auth_confirmation_failed:
    "The email link could not be confirmed. Request a fresh link and try again.",
  email_sign_in_failed:
    "Wallie could not send that magic link. Check the email and try again.",
  invalid_provider:
    "That sign-in provider is not supported on this route.",
  oauth_sign_in_failed:
    "Wallie could not start that provider sign-in flow.",
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

function buildOauthHref(
  provider: "github" | "google",
  mode: "login" | "signup",
  next: string,
) {
  const params = new URLSearchParams({
    mode,
    next,
    provider,
  });

  return `/auth/oauth?${params.toString()}`;
}

export function AuthEntryPanel({
  errorCode,
  mode,
  next,
  statusCode,
}: AuthEntryPanelProps) {
  const isSignup = mode === "signup";
  const alternateHref = isSignup ? loginPath(next) : signupPath(next);
  const alternateLabel = isSignup
    ? "Already have access? Open login."
    : "New here? Create an account first.";
  const errorMessage = errorCode
    ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
    : null;
  const statusMessage = statusCode
    ? authStatusMessages[statusCode as keyof typeof authStatusMessages]
    : null;

  return (
    <section className="w-full rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur sm:p-8">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="space-y-3">
          <StatusChip tone="ready">
            {isSignup ? "Create Access" : "Sign In"}
          </StatusChip>
          <div className="space-y-3">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
              {isSignup
                ? "Create your Wallie identity"
                : "Enter your workspace"}
            </h1>
            <p className="max-w-2xl text-sm leading-7 text-muted sm:text-base">
              {isSignup
                ? "Use magic link or OAuth, then continue into first-workspace setup under Supabase Auth."
                : "Use magic link or OAuth and Wallie will route you to your workspace or first-run onboarding."}
            </p>
          </div>
        </div>

        <Link
          href={alternateHref}
          className="rounded-full border border-border/80 bg-surface-strong/80 px-4 py-2 text-sm font-semibold text-foreground transition hover:border-accent/35 hover:text-accent"
        >
          {alternateLabel}
        </Link>
      </div>

      {statusMessage ? (
        <div className="mt-6 rounded-[1.5rem] border border-amber-500/40 bg-amber-500/12 px-4 py-3 text-sm leading-6 text-amber-950">
          {statusMessage}
        </div>
      ) : null}

      {errorMessage ? (
        <div className="mt-6 rounded-[1.5rem] border border-red-400/50 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-900">
          {errorMessage}
        </div>
      ) : null}

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.15fr_0.85fr]">
        <form
          action="/auth/email"
          method="post"
          className="rounded-[1.75rem] border border-border/80 bg-surface-strong/80 p-5"
        >
          <input type="hidden" name="mode" value={mode} />
          <input type="hidden" name="next" value={next} />

          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-[0.26em] text-muted">
              Magic Link
            </p>
            <h2 className="text-2xl font-semibold tracking-tight text-foreground">
              Email first, password never
            </h2>
            <p className="text-sm leading-6 text-muted">
              Wallie sends a single-use sign-in link and returns you to the exact
              workspace path you came from.
            </p>
          </div>

          <label className="mt-5 block text-sm font-semibold text-foreground">
            Email
            <input
              type="email"
              name="email"
              required
              autoComplete="email"
              placeholder="you@company.com"
              className="mt-2 w-full rounded-2xl border border-border/80 bg-background/70 px-4 py-3 text-base text-foreground outline-none transition focus:border-accent/45"
            />
          </label>

          <button
            type="submit"
            className="mt-5 rounded-full bg-foreground px-5 py-3 text-sm font-semibold text-background transition hover:translate-y-[-1px]"
          >
            {isSignup ? "Send sign-up link" : "Send sign-in link"}
          </button>
        </form>

        <div className="rounded-[1.75rem] border border-border/80 bg-foreground p-5 text-background">
          <p className="text-xs font-semibold uppercase tracking-[0.26em] text-background/70">
            OAuth
          </p>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight">
            Continue with your provider
          </h2>
          <p className="mt-3 text-sm leading-6 text-background/88">
            Supabase Auth handles identity. Workspace access still comes from
            `workspace_members` and RLS after the session is established.
          </p>

          <div className="mt-5 grid gap-3">
            <Link
              href={buildOauthHref("google", mode, next)}
              className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-semibold transition hover:border-white/30 hover:bg-white/12"
            >
              Continue with Google
            </Link>
            <Link
              href={buildOauthHref("github", mode, next)}
              className="rounded-2xl border border-white/15 bg-white/8 px-4 py-3 text-sm font-semibold transition hover:border-white/30 hover:bg-white/12"
            >
              Continue with GitHub
            </Link>
          </div>

          <p className="mt-5 text-xs leading-6 text-background/70">
            If your session already exists, Wallie will skip this screen and send
            you straight to the correct workspace entry route.
          </p>
        </div>
      </div>
    </section>
  );
}
