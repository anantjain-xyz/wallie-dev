import Link from "next/link";

import { AuthForm } from "@/components/auth/auth-form";
import { EmailMagicLinkForm } from "@/components/auth/email-magic-link-form";
import { EmailCodeInputs } from "@/components/auth/email-code-inputs";
import { WallieMark } from "@/components/shared/wallie-mark";
import { loginPath } from "@/lib/routes";

const authErrorMessages = {
  auth_callback_failed: "The sign-in callback did not complete. Start the flow again.",
  auth_confirmation_failed:
    "The sign-in link couldn’t be confirmed. Request a new sign-in email and try again.",
  email_code_failed:
    "That code could not be verified. Check all six digits or request a new code, then try again.",
  email_sign_in_failed:
    "We could not send a sign-in email. Check the address or your connection, then try again.",
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
    "This browser has no pending code request. Open the link in your email, or request a new sign-in email below.";
  let errorMessage = null;
  if (errorCode === "email_code_failed" && missingContinuation) {
    errorMessage = continuationMessage;
  } else if (errorCode === "auth_confirmation_failed" && showEmailCodeForm) {
    errorMessage =
      "The sign-in link couldn’t be confirmed. Enter the code from that email or request a new sign-in email.";
  } else if (errorCode) {
    errorMessage = Object.hasOwn(authErrorMessages, errorCode)
      ? authErrorMessages[errorCode as keyof typeof authErrorMessages]
      : "Sign-in could not be completed. Request a new sign-in email and try again.";
  }
  const requestAnotherCodeHref = loginPath(next);
  const emailStatusMessage = missingContinuation ? continuationMessage : null;
  const codeFeedback = errorMessage ? { kind: "error" as const, message: errorMessage } : null;

  return (
    <div className="w-full max-w-[400px]">
      <div className="mb-10 text-center">
        <WallieMark className="mx-auto mb-4 size-14 text-foreground" />
        <h1 className="text-balance text-2xl font-semibold tracking-tight text-foreground">
          Sign in to Wallie
        </h1>
        <p className="mt-2 text-pretty text-sm leading-6 text-muted">
          {next === "/"
            ? "Use your email to create a workspace or open one you already have."
            : "Sign in to continue to the page you opened."}
        </p>
      </div>

      <div>
        {!showEmailCodeForm ? (
          <div>
            <div className="mb-4">
              <p className="text-sm font-medium text-foreground">Sign in with email</p>
            </div>
            <EmailMagicLinkForm
              defaultEmail={errorCode === "email_sign_in_failed" ? retryEmail : undefined}
              errorMessage={errorMessage}
              next={next}
              statusMessage={emailStatusMessage}
              submitLabel={
                errorCode === "email_sign_in_failed"
                  ? "Try sending again"
                  : missingContinuation || errorCode
                    ? "Request a new sign-in email"
                    : undefined
              }
            />
            <p className="mt-3 text-xs leading-5 text-muted">
              We’ll email a secure link and a six-digit code. No password required.
            </p>
          </div>
        ) : null}

        {showEmailCodeForm ? (
          <div>
            <h2 id="email-code-heading" className="text-xl font-semibold text-foreground">
              Check your email
            </h2>
            <p className="mt-2 text-sm leading-6 text-muted">
              Enter the six-digit code from your email, or use the sign-in link inside.
            </p>
            <AuthForm
              action="/auth/code"
              ariaLabelledBy="email-code-heading"
              className="email-code-form mt-8 grid gap-6"
              feedback={codeFeedback}
              pendingLabel="Verifying code…"
              submitLabel={errorMessage ? "Try code again" : "Continue with code"}
            >
              <input type="hidden" name="next" value={next} />
              <EmailCodeInputs />
            </AuthForm>
            <Link
              href={requestAnotherCodeHref}
              className="ui-touch-target mt-4 inline-flex min-h-11 w-full items-center justify-center rounded-[6px] text-sm font-medium text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30"
            >
              Request a new email
            </Link>
          </div>
        ) : null}
      </div>

      <p className="mt-8 text-center text-xs leading-5 text-muted">
        Looking for Wallie?{" "}
        <Link
          href="/"
          className="inline-flex min-h-11 items-center rounded-[6px] font-medium text-foreground underline decoration-muted underline-offset-4 hover:decoration-foreground"
        >
          Visit the home page
        </Link>
      </p>
    </div>
  );
}
