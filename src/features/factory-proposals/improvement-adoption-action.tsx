"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FactoryImprovementAdoptionCommand } from "@/lib/factory-proposals/adoption-contracts";

export function ImprovementAdoptionAction({
  endpoint,
  command,
}: {
  endpoint: string;
  command: FactoryImprovementAdoptionCommand;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [complete, setComplete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function adopt() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (!response.ok) {
        const result: unknown = await response.json().catch(() => null);
        const message = result && typeof result === "object" && "error" in result && result.error;
        throw new Error(typeof message === "string" ? message : "The adoption request failed.");
      }
      setComplete(true);
      setOpen(false);
      router.refresh();
    } catch (error) {
      setError(error instanceof Error ? error.message : "The adoption request failed.");
    } finally {
      setPending(false);
    }
  }

  return (
    <DestructiveConfirmationDialog
      actionLabel="Verify GitHub and adopt"
      description="Wallie verifies the human approval and merge on GitHub. Future sessions will use the adopted configuration."
      errorMessage={error}
      onConfirm={() => void adopt()}
      onOpenChange={(value) => {
        setError(null);
        setOpen(value);
      }}
      open={open}
      pending={pending}
      pendingLabel="Verifying reviewed merge…"
      title="Adopt the reviewed configuration?"
      trigger={
        <button className="ui-button ui-button-primary" disabled={complete} type="button">
          {complete ? "Configuration adopted" : "Adopt configuration"}
        </button>
      }
    />
  );
}
