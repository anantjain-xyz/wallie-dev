import { CheckIcon } from "@/components/shared/icons/check-icon";

export function SetupCheck({ label = "Completed" }: { label?: string }) {
  return (
    <span className="inline-flex size-4 shrink-0 items-center text-success">
      <CheckIcon className="size-4" />
      <span className="sr-only">{label}</span>
    </span>
  );
}
