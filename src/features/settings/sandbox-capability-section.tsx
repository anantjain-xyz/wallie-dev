"use client";

import { useState } from "react";

import { SelectField } from "@/components/ui/select";
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
  const selectableRepositories = repositories.filter((repository) => !repository.isArchived);
  const repositoryOptions = selectableRepositories.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(
    selectableRepositories[0]?.id ?? "",
  );
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
      payload.check.status === "running"
        ? "Sandbox capability check started."
        : payload.check.status === "success"
          ? "Sandbox capability check passed."
          : "Sandbox capability check finished with failures.",
  });

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        <SelectField
          className="min-w-64 flex-1"
          disabled={!canManage || repositoryOptions.length === 0}
          fallbackLabel="No repositories available"
          label="Repository"
          onValueChange={setSelectedRepositoryId}
          options={repositoryOptions}
          value={selectedRepositoryId}
        />
        <button
          className="ui-button-primary"
          disabled={!canManage || repositoryOptions.length === 0 || runCheck.isBusy}
          onClick={() => void runCheck.run()}
          type="button"
        >
          {runCheck.isBusy ? "Checking…" : "Run capability check"}
        </button>
      </div>

      {check ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-[13px] font-medium text-foreground">
              Latest check:{" "}
              <span
                className={
                  check.status === "success"
                    ? "text-success"
                    : check.status === "error"
                      ? "text-danger"
                      : "text-muted"
                }
              >
                {check.status}
              </span>
            </p>
            <p className="text-[12px] text-muted">{new Date(check.checkedAt).toLocaleString()}</p>
          </div>
          {check.errorText ? (
            <p className="text-[12px] leading-5 text-danger">{check.errorText}</p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => (
              <div
                className={`rounded-[6px] border px-3 py-2 text-[12px] leading-5 ${
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
        <p className="text-[13px] leading-6 text-muted">No sandbox capability check has run yet.</p>
      )}
    </div>
  );
}
