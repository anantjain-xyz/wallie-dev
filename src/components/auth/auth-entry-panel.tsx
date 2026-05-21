import Link from "next/link";

import { isLocalDev } from "@/env/deploy";
import type { OAuthProvider } from "@/lib/auth-providers";

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
  errorCode?: string | null;
  next: string;
  requestedEmail?: string | null;
  statusCode?: string | null;
};

function buildOauthHref(provider: OAuthProvider, next: string) {
  const params = new URLSearchParams({
    next,
    provider,
  });

  return `/auth/oauth?${params.toString()}`;
}

export function AuthEntryPanel({
  errorCode,
  next,
  requestedEmail,
  statusCode,
}: AuthEntryPanelProps) {
  const errorMessage = errorCode
    ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
    : null;
  const statusMessage = statusCode
    ? authStatusMessages[statusCode as keyof typeof authStatusMessages]
    : null;
  const showEmailCodeForm = statusCode === "check_email" || errorCode === "email_code_failed";

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

        {showEmailCodeForm ? (
          <div className="mt-4 border-t border-border pt-4">
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
                  defaultValue={requestedEmail ?? ""}
                  className="ui-input"
                />
              </label>
              <label className="block">
                <span className="sr-only">Six-digit code</span>
                <input
                  type="text"
                  name="token"
                  required
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  maxLength={8}
                  placeholder="6-digit code"
                  className="ui-input text-center font-mono text-[17px]"
                />
              </label>
              <button type="submit" className="ui-button w-full">
                Continue with code
              </button>
            </form>
          </div>
        ) : null}

        <div className="my-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-border" />
          <span className="text-[10px] font-medium uppercase tracking-[0.18em] text-muted">or</span>
          <div className="h-px flex-1 bg-border" />
        </div>

        <div className="grid gap-2">
          <Link href={buildOauthHref("google", next)} className="ui-button w-full gap-2">
            <GoogleGlyph />
            <span>Continue with Google</span>
          </Link>
          <Link href={buildOauthHref("github", next)} className="ui-button w-full gap-2">
            <GitHubGlyph />
            <span>Continue with GitHub</span>
          </Link>
        </div>

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

function GoogleGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 18 18" focusable="false">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.184l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.706a5.412 5.412 0 0 1 0-3.412V4.962H.957a9 9 0 0 0 0 8.076l3.007-2.332Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A9 9 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
      />
    </svg>
  );
}

function GitHubGlyph() {
  return (
    <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" focusable="false">
      <path
        fill="currentColor"
        d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"
      />
    </svg>
  );
}
