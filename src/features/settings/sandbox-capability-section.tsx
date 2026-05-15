"use client";

import { useState } from "react";

import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import type { SandboxCapabilityCheckResponse } from "@/lib/sandbox-capabilities/contracts";

type SandboxCapabilitySectionProps = {
  canManage: boolean;
  initialCheck: SettingsPageData["latestSandboxCapabilityCheck"];
  repositories: SettingsPageData["github"]["repositories"];
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

export function SandboxCapabilitySection({
  canManage,
  initialCheck,
  repositories,
  setFlashMessage,
  workspaceId,
}: SandboxCapabilitySectionProps) {
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(repositories[0]?.id ?? "");
  const [check, setCheck] = useState(initialCheck);

  const runCheck = useApiAction<SandboxCapabilityCheckResponse>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/sandbox-capability-check`, {
        body: JSON.stringify({
          repositoryId: selectedRepositoryId || undefined,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    errorText: "Sandbox capability check failed.",
    onSuccess: (payload) => setCheck(payload.check),
    setFlashMessage,
    successText: (payload) =>
      payload.check.status === "success"
        ? "Sandbox capability check passed."
        : "Sandbox capability check finished with failures.",
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <label className="min-w-64 space-y-2 text-sm font-semibold text-foreground">
          <span>Repository</span>
          <select
            className="ui-input"
            disabled={!canManage || repositories.length === 0}
            onChange={(event) => setSelectedRepositoryId(event.target.value)}
            value={selectedRepositoryId}
          >
            {repositories.map((repository) => (
              <option key={repository.id} value={repository.id}>
                {repository.fullName}
              </option>
            ))}
          </select>
        </label>
        <button
          className="ui-button-primary"
          disabled={!canManage || repositories.length === 0 || runCheck.isBusy}
          onClick={() => void runCheck.run()}
          type="button"
        >
          {runCheck.isBusy ? "Checking…" : "Run capability check"}
        </button>
      </div>

      {check ? (
        <div className="ui-subpanel space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-foreground">
              Latest check: <span className="font-mono">{check.status}</span>
            </p>
            <p className="text-xs text-muted">{new Date(check.checkedAt).toLocaleString()}</p>
          </div>
          {check.errorText ? (
            <p className="text-xs leading-5 text-danger">{check.errorText}</p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => (
              <div
                className={`rounded-[6px] border px-3 py-2 text-xs leading-5 ${
                  result?.ok
                    ? "border-success/20 bg-success-soft text-success"
                    : "border-danger/20 bg-danger-soft text-danger"
                }`}
                key={name}
              >
                <p className="font-semibold">{name}</p>
                <p>{result?.detail ?? "No detail recorded."}</p>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-sm leading-6 text-muted">No sandbox capability check has run yet.</p>
      )}
    </div>
  );
}
