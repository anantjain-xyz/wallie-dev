import Link from "next/link";

import { EmailCodeInputs } from "@/components/auth/email-code-inputs";
import { isLocalDev } from "@/env/deploy";
import { loginPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed: "The sign-in callback did not complete. Start the flow again.",
  auth_confirmation_failed:
    "The email link could not be confirmed. Request a fresh link and try again.",
  email_code_failed: "Wallie could not verify that code. Check the email and code, then try again.",
  email_sign_in_failed: "Wallie could not send that magic link. Check the email and try again.",
  password_auth_failed: "Dev password sign-in failed. Check credentials and try again.",
  invalid_provider: "That sign-in provider is not supported on this route.",
  oauth_sign_in_failed: "Wallie could not start that provider sign-in flow.",
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
    ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
    : null;
  const statusMessage = statusCode
    ? authStatusMessages[statusCode as keyof typeof authStatusMessages]
    : null;
  const showEmailCodeForm =
    canUseEmailCode &&
    (statusCode === "check_email" || (errorCode ? emailCodeFallbackErrors.has(errorCode) : false));
  const requestAnotherCodeHref = loginPath(next);

  return (
    <div className="w-full max-w-[360px]">
      <div className="ui-panel-elevated p-5">
        {statusMessage ? (
          <div
            aria-live="polite"
            role="status"
            className="mb-4 rounded-[6px] border border-border bg-accent-soft px-3 py-2 text-[12px] leading-5 text-foreground"
          >
            {statusMessage}
          </div>
        ) : null}

        {errorMessage ? (
          <div
            aria-live="polite"
            role="status"
            className="mb-4 rounded-[6px] border bg-danger-soft px-3 py-2 text-[12px] leading-5 text-danger"
            style={{ borderColor: "color-mix(in srgb, var(--danger) 22%, white)" }}
          >
            {errorMessage}
          </div>
        ) : null}

        {!showEmailCodeForm ? (
          <form action="/auth/email" method="post" className="space-y-3">
            <input type="hidden" name="next" value={next} />

            <label className="block">
              <span className="sr-only">Email</span>
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@company.com"
                spellCheck={false}
                className="ui-input"
              />
            </label>

            <button type="submit" className="ui-button-primary w-full">
              Send magic link
            </button>
          </form>
        ) : null}

        {showEmailCodeForm ? (
          <div>
            <p id="email-code-heading" className="mb-3 text-[12px] font-medium text-muted">
              Enter 6-digit code emailed to you
            </p>
            <form
              action="/auth/code"
              method="post"
              aria-labelledby="email-code-heading"
              className="space-y-2"
            >
              <input type="hidden" name="next" value={next} />
              <EmailCodeInputs />
              <button type="submit" className="ui-button w-full">
                Continue with code
              </button>
            </form>
            <Link
              href={requestAnotherCodeHref}
              className="mt-3 inline-flex w-full items-center justify-center text-[12px] font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Request another code
            </Link>
          </div>
        ) : null}

        {isLocalDev() && (
          <details className="mt-4 border-t border-border pt-3">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.18em] text-muted transition-colors hover:text-foreground">
              <span aria-hidden="true">›</span>
              Dev password
            </summary>
            <form action="/auth/password" method="post" className="mt-3 space-y-2">
              <input type="hidden" name="next" value={next} />
              <input
                type="email"
                name="email"
                required
                autoComplete="email"
                placeholder="dev@localhost.com"
                className="ui-input"
              />
              <input
                type="password"
                name="password"
                required
                minLength={6}
                autoComplete="current-password"
                placeholder="Password (min 6)"
                className="ui-input"
              />
              <button type="submit" className="ui-button w-full">
                Continue
              </button>
            </form>
          </details>
        )}
      </div>
    </div>
  );
}
