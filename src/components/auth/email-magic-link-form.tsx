import { AuthForm } from "@/components/auth/auth-form";

type EmailMagicLinkFormProps = {
  className?: string;
  errorMessage?: string | null;
  inputClassName?: string;
  next: string;
  statusMessage?: string | null;
  submitClassName?: string;
  submitLabel?: string;
  variant?: "inline" | "stacked";
};

export function EmailMagicLinkForm({
  className,
  errorMessage,
  inputClassName,
  next,
  statusMessage,
  submitClassName,
  submitLabel = "Send magic link",
  variant = "stacked",
}: EmailMagicLinkFormProps) {
  const isInline = variant === "inline";

  return (
    <AuthForm
      action="/auth/email"
      className={
        className ?? (isInline ? "flex flex-col gap-2 sm:flex-row sm:items-center" : "grid gap-3")
      }
      feedback={
        errorMessage
          ? { kind: "error", message: errorMessage }
          : statusMessage
            ? { kind: "status", message: statusMessage }
            : null
      }
      pendingLabel="Sending secure sign-in email…"
      submitClassName={
        submitClassName ??
        (isInline ? "ui-button-primary min-h-11 shrink-0" : "ui-button-primary min-h-11 w-full")
      }
      submitLabel={errorMessage ? "Try sending again" : submitLabel}
    >
      <input type="hidden" name="next" value={next} />

      <label className={isInline ? "min-w-0 flex-1" : "block"}>
        <span className={isInline ? "sr-only" : "ui-label mb-1.5 block text-foreground"}>
          {isInline ? "Email" : "Work email"}
        </span>
        <input
          type="email"
          name="email"
          required
          autoComplete="email"
          inputMode="email"
          placeholder="you@company.com"
          spellCheck={false}
          className={inputClassName ?? "ui-input"}
        />
      </label>
    </AuthForm>
  );
}
