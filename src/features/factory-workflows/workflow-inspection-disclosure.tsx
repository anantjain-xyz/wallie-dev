"use client";

import dynamic from "next/dynamic";
import { useId, useState } from "react";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import type { WorkflowInspectionHeader } from "@/lib/factory-workflows/inspection-contracts";
import { cn } from "@/lib/utils";

const WorkflowInspectionPanel = dynamic(
  () =>
    import("./workflow-inspection-panel").then(
      ({ WorkflowInspectionPanel }) => WorkflowInspectionPanel,
    ),
  {
    loading: () => (
      <p className="px-3 py-2 text-sm text-muted" role="status">
        Loading workflow…
      </p>
    ),
  },
);

export function WorkflowInspectionDisclosure({
  header,
  initialNow,
  workspaceSlug,
}: {
  header: WorkflowInspectionHeader;
  initialNow: string;
  workspaceSlug: string;
}) {
  const [state, setState] = useState<"unopened" | "open" | "closed">("unopened");
  const id = useId();
  const open = state === "open";
  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-controls={id}
        aria-expanded={open}
        className="inline-flex min-h-9 items-center gap-1.5 rounded-[4px] text-xs text-muted hover:text-foreground focus-visible:outline-accent"
        onClick={() => setState(open ? "closed" : "open")}
      >
        Workflow
        <ChevronDownIcon
          className={cn(
            "size-3.5 transition-transform motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <section aria-label="Workflow inspection" hidden={!open} id={id}>
        {state === "unopened" ? null : (
          <WorkflowInspectionPanel
            header={header}
            initialNow={initialNow}
            workspaceSlug={workspaceSlug}
          />
        )}
      </section>
    </div>
  );
}
