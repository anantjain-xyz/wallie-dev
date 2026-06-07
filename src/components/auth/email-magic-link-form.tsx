type EmailMagicLinkFormProps = {
  className?: string;
  inputClassName?: string;
  next: string;
  submitClassName?: string;
  submitLabel?: string;
  variant?: "inline" | "stacked";
};

export function EmailMagicLinkForm({
  className,
  inputClassName,
  next,
  submitClassName,
  submitLabel = "Send magic link",
  variant = "stacked",
}: EmailMagicLinkFormProps) {
  const isInline = variant === "inline";

  return (
    <form
      action="/auth/email"
      method="post"
      className={
        className ?? (isInline ? "flex flex-col gap-2 sm:flex-row sm:items-center" : "space-y-3")
      }
    >
      <input type="hidden" name="next" value={next} />

      <label className={isInline ? "min-w-0 flex-1" : "block"}>
        <span className="sr-only">Email</span>
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

      <button
        type="submit"
        className={
          submitClassName ?? (isInline ? "ui-button-primary shrink-0" : "ui-button-primary w-full")
        }
      >
        {submitLabel}
      </button>
    </form>
  );
}
