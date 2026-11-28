import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { EmailCodeInputs } from "@/components/auth/email-code-inputs";
import { WallieMark } from "@/components/shared/wallie-mark";
import { BackLink } from "@/components/ui/back-link";
import { loginPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed: "Sign-in didn’t finish. Request a new email below.",
  auth_confirmation_failed: "The sign-in link couldn’t be confirmed. Request a new email below.",
  email_code_failed:
    "That code couldn’t be verified. Check all 6 digits, or request a new email if the code has expired.",
  email_sign_in_failed:
    "We couldn’t send a sign-in email. Check the address or wait a moment before trying again.",
  invalid_provider: "That sign-in method isn’t available. Use your email to sign in.",
  oauth_sign_in_failed: "That sign-in method couldn’t start. Use your email to sign in.",
} as const;

type AuthEntryPanelProps = {
  canUseEmailCode?: boolean;
  errorCode?: string | null;
  next: string;
  retryEmail?: string;
  statusCode?: string | null;
};

const emailCodeFallbackErrors = new Set(["auth_confirmation_failed", "email_code_failed"]);

export function AuthEntryPanel({
  canUseEmailCode = false,
  errorCode,
  next,
  retryEmail,
  statusCode,
}: AuthEntryPanelProps) {
  const showEmailCodeForm =
    canUseEmailCode &&
    (errorCode ? emailCodeFallbackErrors.has(errorCode) : statusCode === "check_email");
  const missingContinuation =
    !canUseEmailCode && (statusCode === "check_email" || errorCode === "email_code_failed");
  const continuationMessage =
    "There’s no pending code in this browser. Use the link in your email or request a new email here.";
  let errorMessage = null;
  if (errorCode === "email_code_failed" && missingContinuation) {
    errorMessage = continuationMessage;
  } else if (errorCode === "auth_confirmation_failed" && showEmailCodeForm) {
    errorMessage = "The sign-in link couldn’t be confirmed. Try the code from that email instead.";
  } else if (errorCode) {
    errorMessage = Object.hasOwn(authErrorMessages, errorCode)
      ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
      : "Sign-in didn’t finish. Request a new email below.";
  }
  const feedback = errorMessage
    ? { kind: "error" as const, message: errorMessage }
    : missingContinuation
      ? { kind: "status" as const, message: continuationMessage }
      : null;
  const nextMessage =
    next === "/"
      ? "After you sign in, Wallie opens your workspace or asks you to create one."
      : "After you sign in, you’ll return to the page you opened.";

  return (
    <div className="w-full max-w-[400px]">
      <header className="mb-5 space-y-2">
        <WallieMark className="mb-3 size-9 text-foreground" />
        <h1 id="sign-in-heading" className="type-page-title">
          {showEmailCodeForm ? "Check your email" : "Sign in to Wallie"}
        </h1>
        {showEmailCodeForm ? (
          <p className="type-body text-pretty text-foreground">
            Open the sign-in link in your email, or enter the 6-digit code below.
          </p>
        ) : null}
        <p className="type-body text-pretty text-muted">{nextMessage}</p>
      </header>

      {showEmailCodeForm ? (
        <>
          <AuthForm
            action="/auth/code"
            ariaLabelledBy="sign-in-heading"
            className="email-code-form grid gap-4"
            feedback={feedback}
            pendingLabel="Verifying code…"
            submitLabel="Verify code"
          >
            <input type="hidden" name="next" value={next} />
            <EmailCodeInputs />
          </AuthForm>
          <Link
            href={loginPath(next)}
            className="ui-touch-target mt-1 inline-flex min-h-11 items-center rounded-[6px] text-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            Request a new email
          </Link>
        </>
      ) : (
        <>
          <AuthForm
            action="/auth/email"
            ariaLabelledBy="sign-in-heading"
            className="grid gap-3"
            feedback={feedback}
            pendingLabel="Sending sign-in email…"
            submitLabel={
              errorCode === "email_sign_in_failed"
                ? "Try sending again"
                : missingContinuation || errorCode
                  ? "Request a new email"
                  : "Send sign-in email"
            }
          >
            <input type="hidden" name="next" value={next} />
            <label className="block">
              <span className="ui-label mb-1.5 block text-foreground">Work email</span>
              <input
                aria-describedby="email-delivery"
                type="email"
                name="email"
                defaultValue={errorCode === "email_sign_in_failed" ? retryEmail : undefined}
                required
                autoComplete="email"
                inputMode="email"
                placeholder="you@company.com"
                spellCheck={false}
                className="ui-input"
              />
            </label>
          </AuthForm>
          <p id="email-delivery" className="type-secondary mt-2 text-muted">
            We’ll send a link and a 6-digit code. No password needed.
          </p>
        </>
      )}
      <BackLink
        href="/"
        className="ui-touch-target mt-4 min-h-11 w-fit rounded-[6px] text-sm text-muted underline decoration-border-strong underline-offset-4 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        Back to Wallie
      </BackLink>
    </div>
  );
}
