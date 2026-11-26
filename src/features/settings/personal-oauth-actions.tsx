"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import type { FactoryOAuthManagementCommand } from "@/lib/factory-oauth/management-contracts";

export function DisconnectPersonalClient({
  grantId,
  identity,
  metadata,
  name,
  workspaceId,
}: {
  grantId: string;
  identity: string;
  metadata: ReactNode;
  name: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const action = useApiAction<{ revoked: true }>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/oauth-clients`, {
        body: JSON.stringify({
          action: "revoke-grant",
          grantId,
        } satisfies FactoryOAuthManagementCommand),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
    errorText: "Could not disconnect this client.",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  return (
    <DestructiveConfirmationDialog
      actionLabel="Disconnect client"
      description={
        <>
          This connection will lose read and command access.
          <span className="mt-2 block">{metadata}</span>
        </>
      }
      errorMessage={feedback?.text}
      onConfirm={() => void action.run()}
      onOpenChange={(value) => {
        setOpen(value);
        setFeedback(null);
      }}
      open={open}
      pending={action.isBusy}
      pendingLabel="Disconnecting…"
      title={`Disconnect ${name}?`}
      trigger={
        <button
          aria-label={`Disconnect client: ${identity}`}
          className="ui-button-danger"
          type="button"
        >
          Disconnect client
        </button>
      }
    />
  );
}

export function ConnectionSupportDetails({ grantId }: { grantId: string }) {
  const [feedback, setFeedback] = useState("");
  return (
    <details className="type-secondary text-muted">
      <summary className="w-fit cursor-pointer rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">
        Support details
      </summary>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <span>
          Connection ID:{" "}
          <code className="type-code select-all [overflow-wrap:anywhere]">{grantId}</code>
        </span>
        <button
          className="ui-button min-h-9"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(grantId);
              setFeedback("Connection ID copied.");
            } catch {
              setFeedback("Copy failed. Select the connection ID and copy it manually.");
            }
          }}
          type="button"
        >
          Copy connection ID
        </button>
      </div>
      <p role="status">{feedback}</p>
    </details>
  );
}
