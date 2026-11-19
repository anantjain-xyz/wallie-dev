"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { SelectField } from "@/components/ui/select";
import { Status, type StatusValue } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { dateFormatter } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  SandboxCapabilityCheckLatestResponse,
  SandboxCapabilityCheckResponse,
  SandboxCapabilityCheckState,
} from "@/lib/sandbox-capabilities/contracts";

export type CapabilityRepository = Pick<
  SettingsPageData["github"]["repositories"][number],
  "id" | "fullName" | "isArchived"
>;

type DefinitionTarget = { id: string; kind: "draft" | "revision"; repositoryId: string };

type SandboxCapabilitySectionProps = {
  definitionEndpoint?: string;
  definitionTarget?: DefinitionTarget;
  canManage: boolean;
  initialCheck: SettingsPageData["latestSandboxCapabilityCheck"];
  onCheckChange?: (check: NonNullable<SettingsPageData["latestSandboxCapabilityCheck"]>) => void;
  onDefinitionRepositoryChange?: (repositoryId: string) => void;
  preferredRepositoryId?: string | null;
  repositories: readonly CapabilityRepository[];
  sandboxConnected: boolean;
  setFlashMessage: (message: FlashMessage) => void;
  workspaceId: string;
};

const sandboxStatusValues = {
  error: "blocked",
  running: "running",
  success: "healthy",
} satisfies Record<SandboxCapabilityCheckState["status"], StatusValue>;

export function resolveSandboxRepositorySelection({
  currentRepositoryId,
  preferredRepositoryId,
  repositories,
}: {
  currentRepositoryId: string;
  preferredRepositoryId?: string | null;
  repositories: readonly CapabilityRepository[];
}) {
  const selectableRepositories = repositories.filter((repository) => !repository.isArchived);
  const hasPreferredRepository = selectableRepositories.some(
    (repository) => repository.id === preferredRepositoryId,
  );

  if (hasPreferredRepository) {
    return preferredRepositoryId ?? "";
  }

  const currentRepositoryStillAvailable = selectableRepositories.some(
    (repository) => repository.id === currentRepositoryId,
  );
  if (currentRepositoryStillAvailable) {
    return currentRepositoryId;
  }

  return selectableRepositories[0]?.id ?? "";
}

export function markSandboxCapabilityCheckPollingFailed(
  check: SandboxCapabilityCheckState,
  message: string,
  checkedAt = new Date().toISOString(),
): SandboxCapabilityCheckState {
  return {
    ...check,
    checkedAt,
    errorText: message,
    status: "error",
  };
}

export function SandboxCapabilitySection({
  canManage,
  definitionTarget,
  definitionEndpoint,
  initialCheck,
  onCheckChange,
  onDefinitionRepositoryChange,
  preferredRepositoryId,
  repositories,
  sandboxConnected,
  setFlashMessage,
  workspaceId,
}: SandboxCapabilitySectionProps) {
  const selectableRepositories = repositories.filter((repository) => !repository.isArchived);
  const repositoryOptions = selectableRepositories.map((repository) => ({
    label: repository.fullName,
    value: repository.id,
  }));
  const [selectedRepositoryId, setSelectedRepositoryId] = useState(
    resolveSandboxRepositorySelection({
      currentRepositoryId: "",
      preferredRepositoryId,
      repositories,
    }),
  );
  const [loadedCheck, setCheck] = useState(initialCheck);
  const [loadedTargetQuery, setLoadedTargetQuery] = useState<string | null>(null);
  const endpoint = definitionTarget
    ? (definitionEndpoint ?? `/api/workspaces/${workspaceId}/factory-definition/capability-check`)
    : `/api/workspaces/${workspaceId}/sandbox-capability-check`;
  const targetQuery = definitionTarget
    ? new URLSearchParams({
        [definitionTarget.kind === "draft" ? "draftId" : "revisionId"]: definitionTarget.id,
        ...(onDefinitionRepositoryChange ? { repositoryId: definitionTarget.repositoryId } : {}),
      }).toString()
    : null;
  const loading = targetQuery !== loadedTargetQuery;
  const check =
    !definitionTarget || loadedCheck?.githubRepositoryId === definitionTarget.repositoryId
      ? loadedCheck
      : null;
  const repository = selectableRepositories.find(({ id }) => id === definitionTarget?.repositoryId);
  const latestCheckRef = useRef(check);
  const repositoryIdsKey = selectableRepositories.map((repository) => repository.id).join("|");

  useEffect(() => {
    latestCheckRef.current = check;
  }, [check]);

  useEffect(() => {
    setSelectedRepositoryId((currentRepositoryId) =>
      resolveSandboxRepositorySelection({
        currentRepositoryId,
        preferredRepositoryId,
        repositories,
      }),
    );
  }, [preferredRepositoryId, repositories, repositoryIdsKey]);

  useEffect(() => {
    if (!targetQuery) return;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(`${endpoint}?${targetQuery}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = (await response.json()) as SandboxCapabilityCheckLatestResponse;
        if (!response.ok) throw new Error("Could not load the factory capability check.");
        if (!controller.signal.aborted) setCheck(body.check);
      } catch {
        if (!controller.signal.aborted) {
          setFlashMessage({ kind: "error", text: "Could not load the factory capability check." });
        }
      } finally {
        if (!controller.signal.aborted) setLoadedTargetQuery(targetQuery);
      }
    })();
    return () => controller.abort();
  }, [endpoint, setFlashMessage, targetQuery]);

  const runCheck = useApiAction<SandboxCapabilityCheckResponse>({
    call: () =>
      fetch(endpoint, {
        body: JSON.stringify(
          definitionTarget
            ? {
                target: { kind: definitionTarget.kind, id: definitionTarget.id },
                ...(onDefinitionRepositoryChange
                  ? { repositoryId: definitionTarget.repositoryId }
                  : {}),
              }
            : { repositoryId: selectedRepositoryId || undefined },
        ),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }),
    errorText: "Sandbox capability check failed.",
    onSuccess: (payload) => {
      setCheck(payload.check);
      onCheckChange?.(payload.check);
    },
    setFlashMessage,
    successText: (payload) =>
      payload.check.status === "running"
        ? "Sandbox capability check started."
        : payload.check.status === "success"
          ? "Sandbox capability check passed."
          : "Sandbox capability check finished with failures.",
  });

  const isPolling = check?.status === "running";

  useEffect(() => {
    const repositoryId = check?.githubRepositoryId;
    if (!isPolling || !repositoryId) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(
          `${endpoint}?${targetQuery ?? new URLSearchParams({ repositoryId })}`,
          { cache: "no-store" },
        );
        const body = (await response.json().catch(() => null)) as
          | (SandboxCapabilityCheckLatestResponse & { error?: string })
          | null;
        if (!response.ok || !body?.check) {
          throw new Error(body?.error ?? "Capability check polling failed.");
        }
        if (cancelled) return;
        const nextCheck = body.check;
        setCheck(nextCheck);
        onCheckChange?.(nextCheck);
        if (nextCheck.status !== "running") {
          window.clearInterval(timer);
          if (nextCheck.status === "success") {
            setFlashMessage({ kind: "success", text: "Sandbox capability check passed." });
          } else if (nextCheck.status === "error") {
            setFlashMessage({
              kind: "error",
              text: "Sandbox capability check finished with failures.",
            });
          }
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "Capability check polling failed.";
        const currentCheck = latestCheckRef.current;
        if (
          currentCheck?.status === "running" &&
          currentCheck.githubRepositoryId === repositoryId
        ) {
          const nextCheck = markSandboxCapabilityCheckPollingFailed(currentCheck, message);
          latestCheckRef.current = nextCheck;
          setCheck(nextCheck);
          onCheckChange?.(nextCheck);
        }
        setFlashMessage({ kind: "error", text: message });
        window.clearInterval(timer);
      }
    }, 2000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [check?.githubRepositoryId, endpoint, isPolling, onCheckChange, setFlashMessage, targetQuery]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end gap-3">
        {definitionTarget && !onDefinitionRepositoryChange ? (
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted">Repository</p>
            <p className="break-words text-sm text-foreground">
              {repository?.fullName ?? "Unavailable"}
            </p>
          </div>
        ) : (
          <SelectField
            className="min-w-64 flex-1"
            disabled={
              !canManage ||
              repositoryOptions.length === 0 ||
              Boolean(definitionTarget && runCheck.isBusy)
            }
            fallbackLabel={
              definitionTarget ? "Repository unavailable" : "No repositories available"
            }
            label="Repository"
            onValueChange={onDefinitionRepositoryChange ?? setSelectedRepositoryId}
            options={repositoryOptions}
            value={definitionTarget?.repositoryId ?? selectedRepositoryId}
          />
        )}
        <button
          className="ui-button-primary"
          disabled={
            !canManage ||
            !sandboxConnected ||
            (definitionTarget ? !repository : repositoryOptions.length === 0) ||
            loading ||
            runCheck.isBusy ||
            isPolling
          }
          onClick={() => void runCheck.run()}
          type="button"
        >
          <ActionButtonLabel
            idle="Run capability check"
            pending={runCheck.isBusy || isPolling}
            pendingLabel={runCheck.isBusy ? "Starting…" : "Checking…"}
          />
        </button>
      </div>
      {!sandboxConnected ? (
        <p className="text-xs leading-5 text-warning">
          Connect a sandbox provider before running a capability check.
        </p>
      ) : null}

      {loading ? (
        <p className="text-[13px] leading-6 text-muted" role="status">
          Loading capability check…
        </p>
      ) : check ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <p className="text-[13px] font-medium text-foreground">Latest check</p>
              <Status compact value={sandboxStatusValues[check.status]} />
            </div>
            <p className="text-xs text-muted">{dateFormatter.format(new Date(check.checkedAt))}</p>
          </div>
          {check.errorText ? (
            <p className="text-xs leading-5 text-danger">{check.errorText}</p>
          ) : null}
          <div className="grid gap-2 md:grid-cols-2">
            {Object.entries(check.capabilities).map(([name, result]) => {
              const value: StatusValue = result?.ok
                ? "healthy"
                : result?.detail
                  ? "blocked"
                  : "not_started";
              return (
                <div className="rounded-[6px] border border-border px-3 py-2" key={name}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">{name}</p>
                    <Status compact value={value} />
                  </div>
                  <p className="mt-1 text-xs leading-5 text-muted">
                    {result?.detail ?? "No detail recorded."}
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="text-[13px] leading-6 text-muted">No sandbox capability check has run yet.</p>
      )}
    </div>
  );
}
