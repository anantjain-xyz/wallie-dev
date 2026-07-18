import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { EmailMagicLinkForm } from "@/components/auth/email-magic-link-form";
import { EmailCodeInputs } from "@/components/auth/email-code-inputs";
import { isLocalDev } from "@/env/deploy";
import { loginPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed: "The sign-in callback did not complete. Start the flow again.",
  auth_confirmation_failed:
    "The email link could not be confirmed. Request a fresh link and try again.",
  email_code_failed:
    "That code could not be verified. Check all six digits or request a new code, then try again.",
  email_sign_in_failed:
    "We could not send a sign-in email. Check the address or your connection, then try again.",
  password_auth_failed: "Dev password sign-in failed. Check credentials and try again.",
  invalid_provider: "That sign-in provider is not supported on this route.",
  oauth_sign_in_failed: "That sign-in method could not start. Choose another method and try again.",
} as const;

const authStatusMessages = {
  check_email:
    "Check your inbox for a secure sign-in link or six-digit code. It will continue into your workspace flow.",
} as const;

type AuthEntryPanelProps = {
  canUseEmailCode?: boolean;
  errorCode?: string | null;
  next: string;
  statusCode?: string | null;
};

const emailCodeFallbackErrors = new Set(["auth_confirmation_failed", "email_code_failed"]);

export function AuthEntryPanel({
  canUseEmailCode = false,
  errorCode,
  next,
  statusCode,
}: AuthEntryPanelProps) {
  const errorMessage = errorCode
    ? (authErrorMessages[errorCode as keyof typeof authErrorMessages] ??
      "Sign-in could not be completed. Try again or request a new sign-in email.")
    : null;
  const statusMessage = statusCode
    ? authStatusMessages[statusCode as keyof typeof authStatusMessages]
    : null;
  const showEmailCodeForm =
    canUseEmailCode &&
    (statusCode === "check_email" || (errorCode ? emailCodeFallbackErrors.has(errorCode) : false));
  const requestAnotherCodeHref = loginPath(next);
  const emailErrorMessage = errorCode === "password_auth_failed" ? null : errorMessage;
  const codeFeedback = errorMessage
    ? { kind: "error" as const, message: errorMessage }
    : statusMessage
      ? { kind: "status" as const, message: statusMessage }
      : null;

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-6 text-center">
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
          Sign in to Wallie
        </h1>
        <p className="mt-2 text-pretty text-sm leading-6 text-muted">
          Continue to your workspace and review active sessions.
        </p>
      </div>

      <div className="ui-sheet p-4 sm:p-6">
        {!showEmailCodeForm ? (
          <div>
            <div className="mb-4 flex items-center justify-between gap-3">
              <p className="text-sm font-medium text-foreground">Sign in with email</p>
              <span className="rounded-full bg-accent-soft px-2 py-1 text-xs font-medium text-accent">
                Recommended
              </span>
            </div>
            <EmailMagicLinkForm errorMessage={emailErrorMessage} next={next} />
            <p className="mt-3 text-xs leading-5 text-muted">
              We’ll email a secure link and a six-digit code. No password required.
            </p>
          </div>
        ) : null}

        {showEmailCodeForm ? (
          <div>
            <h2 id="email-code-heading" className="text-base font-semibold text-foreground">
              Check your email
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted">
              Enter the six-digit code from your Wallie sign-in email.
            </p>
            <AuthForm
              action="/auth/code"
              ariaLabelledBy="email-code-heading"
              className="email-code-form mt-4 space-y-3"
              feedback={codeFeedback}
              pendingLabel="Verifying code…"
              submitLabel={errorMessage ? "Try code again" : "Continue with code"}
            >
              <input type="hidden" name="next" value={next} />
              <EmailCodeInputs />
            </AuthForm>
            <Link
              href={requestAnotherCodeHref}
              className="ui-touch-target mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-[6px] text-sm font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            >
              Request a new email
            </Link>
          </div>
        ) : null}

        {isLocalDev() && (
          <details
            className="mt-5 border-t border-border pt-4"
            open={errorCode === "password_auth_failed" ? true : undefined}
          >
            <summary className="inline-flex min-h-11 w-full cursor-pointer list-none items-center justify-center gap-1.5 rounded-[6px] text-xs font-medium uppercase tracking-[0.14em] text-muted transition-colors hover:text-foreground">
              <span aria-hidden="true">›</span>
              Development alternative
            </summary>
            <AuthForm
              action="/auth/password"
              className="mt-3 space-y-3"
              feedback={
                errorCode === "password_auth_failed" && errorMessage
                  ? { kind: "error", message: errorMessage }
                  : null
              }
              pendingLabel="Signing in…"
              submitClassName="ui-button w-full"
              submitLabel={
                errorCode === "password_auth_failed"
                  ? "Try password again"
                  : "Continue with password"
              }
            >
              <input type="hidden" name="next" value={next} />
              <label className="block">
                <span className="ui-label mb-1.5 block text-foreground">Developer email</span>
                <input
                  type="email"
                  name="email"
                  required
                  autoComplete="email"
                  inputMode="email"
                  placeholder="dev@localhost.com"
                  className="ui-input"
                />
              </label>
              <label className="block">
                <span className="ui-label mb-1.5 block text-foreground">Developer password</span>
                <input
                  type="password"
                  name="password"
                  required
                  minLength={6}
                  autoComplete="current-password"
                  className="ui-input"
                />
              </label>
            </AuthForm>
          </details>
        )}
      </div>

      <p className="mt-5 text-center text-xs leading-5 text-muted">
        Looking for Wallie?{" "}
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-[6px] font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground"
        >
          Visit the home page
        </Link>
      </p>
    </div>
  );
}
