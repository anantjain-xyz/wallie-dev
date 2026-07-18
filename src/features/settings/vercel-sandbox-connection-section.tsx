"use client";

import { useState } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Status, configurationStatusFromTone } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  VercelSandboxConnectionPreview,
  VercelSandboxConnectionResponse,
} from "@/lib/vercel-sandbox/contracts";

type VercelSandboxConnectionSectionProps = {
  canManage: boolean;
  connection: VercelSandboxConnectionPreview | null;
  onConnectionChange: (connection: VercelSandboxConnectionPreview | null) => void;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

function connectionStatusTone(connection: VercelSandboxConnectionPreview | null) {
  if (!connection) return "warning" as const;
  return connection.status === "connected" ? ("success" as const) : ("danger" as const);
}

function connectionStatusLabel(connection: VercelSandboxConnectionPreview | null) {
  if (!connection) return "Missing";
  return connection.status === "connected" ? "Connected" : "Needs attention";
}

export function VercelSandboxConnectionSection({
  canManage,
  connection,
  onConnectionChange,
  setFlashMessage,
  workspaceId,
}: VercelSandboxConnectionSectionProps) {
  const [token, setToken] = useState("");
  const [teamId, setTeamId] = useState(connection?.teamId ?? "");
  const [projectId, setProjectId] = useState(connection?.projectId ?? "");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const saveConnection = useApiAction<VercelSandboxConnectionResponse>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/vercel-sandbox-connection`, {
        body: JSON.stringify({
          projectId,
          teamId,
          token,
        }),
        headers: { "Content-Type": "application/json" },
        method: "PUT",
      }),
    errorText: "Vercel Sandbox connection failed.",
    onSuccess: (payload) => {
      onConnectionChange(payload.connection);
      setToken("");
    },
    setFlashMessage,
    successText: "Vercel Sandbox connection saved.",
  });

  const disconnect = useApiAction<VercelSandboxConnectionResponse, [], boolean>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/vercel-sandbox-connection`, {
        method: "DELETE",
      }),
    errorText: "Vercel Sandbox disconnect failed.",
    onError: (message) => {
      setDisconnectError(message);
      return false;
    },
    onSuccess: (payload) => {
      onConnectionChange(payload.connection);
      return true;
    },
    setFlashMessage: (message) => {
      if (message.kind === "success") setFlashMessage(message);
    },
    successText: "Vercel Sandbox disconnected.",
  });

  function handleSave() {
    if (!token.trim() || !teamId.trim() || !projectId.trim()) {
      setFlashMessage({
        kind: "error",
        text: "Enter a Vercel token, team id, and project id.",
      });
      return;
    }

    void saveConnection.run();
  }

  async function handleDisconnect() {
    setDisconnectError(null);
    if (await disconnect.run()) setDisconnectOpen(false);
  }

  return (
    <Section
      anchorId="vercel"
      tagline="Wallie session sandboxes are created in this workspace's Vercel project. Token values are encrypted and never returned to the browser."
      title="Vercel Sandbox"
    >
      <div className="space-y-6">
        <div className="flex flex-col gap-3 rounded-[6px] border border-border bg-sheet px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-[13px] font-medium text-foreground">Vercel Sandbox</p>
              <Status
                label={connectionStatusLabel(connection)}
                value={configurationStatusFromTone(connectionStatusTone(connection))}
              />
            </div>
            {connection ? (
              <p className="text-xs leading-5 text-muted">
                {connection.projectName ?? connection.projectId} on {connection.teamId}
                {connection.tokenPreview ? ` - ${connection.tokenPreview}` : ""}
              </p>
            ) : (
              <p className="text-xs leading-5 text-muted">
                Connect a Vercel project before running Wallie sessions.
              </p>
            )}
            {connection?.lastValidationError ? (
              <p className="text-xs leading-5 text-danger">{connection.lastValidationError}</p>
            ) : null}
          </div>
          {connection && canManage ? (
            <DestructiveConfirmationDialog
              actionLabel="Disconnect Vercel Sandbox"
              description={`Disconnecting ${connection.projectName ?? connection.projectId} prevents this workspace from starting new sandbox runs until another Vercel connection is saved.`}
              errorMessage={disconnectError}
              onConfirm={() => void handleDisconnect()}
              onOpenChange={(open) => {
                setDisconnectOpen(open);
                setDisconnectError(null);
              }}
              open={disconnectOpen}
              pending={disconnect.isBusy}
              pendingLabel="Disconnecting…"
              title={`Disconnect ${connection.projectName ?? connection.projectId}?`}
              trigger={
                <button
                  aria-label="Disconnect Vercel Sandbox"
                  className="ui-button-danger"
                  type="button"
                >
                  Disconnect
                </button>
              }
            />
          ) : null}
        </div>

        {canManage ? (
          <div className="grid gap-4 md:grid-cols-2">
            <label className="block space-y-1.5 md:col-span-2">
              <span className="text-[13px] font-medium text-foreground">Vercel token</span>
              <input
                autoComplete="off"
                className="ui-input"
                onChange={(event) => setToken(event.target.value)}
                placeholder="vca_…"
                spellCheck={false}
                type="password"
                value={token}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-foreground">Team id</span>
              <input
                autoComplete="off"
                className="ui-input"
                onChange={(event) => setTeamId(event.target.value)}
                placeholder="team_…"
                spellCheck={false}
                value={teamId}
              />
            </label>
            <label className="block space-y-1.5">
              <span className="text-[13px] font-medium text-foreground">Project id</span>
              <input
                autoComplete="off"
                className="ui-input"
                onChange={(event) => setProjectId(event.target.value)}
                placeholder="prj_…"
                spellCheck={false}
                value={projectId}
              />
            </label>
            <div className="flex justify-end md:col-span-2">
              <button
                className="ui-button-primary"
                disabled={saveConnection.isBusy}
                onClick={handleSave}
                type="button"
              >
                {saveConnection.isBusy ? "Validating…" : "Save Vercel connection"}
              </button>
            </div>
          </div>
        ) : (
          <p className="text-[13px] leading-6 text-muted">
            Workspace admins can connect the Vercel Sandbox project used for Wallie runs.
          </p>
        )}
      </div>
    </Section>
  );
}

export function vercelConnectionHealth(
  connection: VercelSandboxConnectionPreview | null,
): SettingsPageData["setupHealth"]["vercelSandboxConnection"] {
  if (!connection) {
    return {
      connected: false,
      lastValidationError: null,
      projectId: null,
      projectName: null,
      status: "missing",
      teamId: null,
      updatedAt: null,
    };
  }

  return {
    connected: connection.status === "connected",
    lastValidationError: connection.lastValidationError,
    projectId: connection.projectId,
    projectName: connection.projectName,
    status: connection.status,
    teamId: connection.teamId,
    updatedAt: connection.updatedAt,
  };
}
