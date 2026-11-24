import { useId, type ComponentProps } from "react";

export function ConnectorSelect({
  className = "block max-w-xs space-y-1.5 text-sm font-medium text-foreground",
  label,
  ...props
}: ComponentProps<"select"> & { label: string }) {
  const labelId = useId();
  return (
    <label className={className}>
      <span className="block" id={labelId}>
        {label}
      </span>
      <select {...props} aria-labelledby={labelId} className="ui-input" />
    </label>
  );
}
