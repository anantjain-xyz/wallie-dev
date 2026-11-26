"use client";

import { useToast } from "@/components/ui/toast";

export function TechnicalId({ label, value }: { label: string; value: string }) {
  const { pushToast } = useToast();
  return (
    <details className="type-secondary min-w-0 text-muted">
      <summary className="cursor-pointer">Technical details</summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="min-w-0 select-all [overflow-wrap:anywhere]" translate="no">
          {value}
        </code>
        <button
          className="ui-button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              pushToast({ title: `${label} copied`, tone: "success" });
            } catch {
              pushToast({
                title: `Could not copy ${label.toLowerCase()}. Select and copy it manually.`,
              });
            }
          }}
          type="button"
        >
          Copy {label.toLowerCase()}
        </button>
      </div>
    </details>
  );
}
