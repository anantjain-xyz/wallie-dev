import { CheckIcon } from "@/components/shared/icons/check-icon";
import { cn } from "@/lib/utils";

export const ONBOARDING_COMPLETION_LABEL = "Done";

type CompletionMarkProps = {
  className?: string;
  label?: typeof ONBOARDING_COMPLETION_LABEL | "Set up";
};

export function CompletionMark({
  className,
  label = ONBOARDING_COMPLETION_LABEL,
}: CompletionMarkProps) {
  return (
    <span className={cn("inline-flex shrink-0 text-success", className)}>
      <CheckIcon className="h-3.5 w-3.5" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
