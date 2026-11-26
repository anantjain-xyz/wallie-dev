"use client";

import { useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  maintenanceTickResponseSchema,
  type MaintenanceTickResponse,
} from "@/lib/maintenance/contracts";

function resultMessage({
  cleanup,
  reconciliation,
  githubVerification,
}: MaintenanceTickResponse): FlashMessage {
  const issues: string[] = [];
  if (!cleanup || cleanup.incomplete) issues.push("Stalled-job recovery did not finish.");
  if (!reconciliation || reconciliation.incomplete)
    issues.push("Some Linear checks did not finish.");
  if (reconciliation?.skipped) {
    issues.push("Linear skipped linked sessions because this workspace has no connection.");
  }
  if (reconciliation?.rateLimited) {
    issues.push(
      "Linear paused checks because of its rate limit. Wait for it to reset before retrying.",
    );
  }
  if (!githubVerification) {
    issues.push("GitHub verification did not finish.");
  } else {
    const { checked, failed, refreshed, limited } = githubVerification;
    if (failed) {
      issues.push(
        `GitHub verification failed for ${failed} ${failed === 1 ? "pull request" : "pull requests"}.`,
      );
    }
    if (checked > refreshed + failed) issues.push("Some GitHub checks could not be saved.");
    if (limited)
      issues.push(
        "GitHub reached its per-run limit. The scheduled worker checks for remaining work.",
      );
  }
  if (!cleanup && !reconciliation && !githubVerification) {
    return { kind: "error", text: "Maintenance could not finish any checks. Try again later." };
  }
  if (issues.length)
    return { kind: "info", text: `Maintenance returned partial results. ${issues.join(" ")}` };
  return {
    kind: "success",
    text: "Maintenance pass finished. See what it checked and changed below.",
  };
}

const countFormat = new Intl.NumberFormat();

function SummaryCell({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1 rounded-[6px] border border-border bg-canvas px-3 py-2">
      <dt className="type-label text-muted">{label}</dt>
      <dd className="text-[13px] font-semibold tabular-nums text-foreground">
        {countFormat.format(value)}
      </dd>
    </div>
  );
}

export function MaintenancePanel({
  workspaceId,
  workspaceName,
}: {
  workspaceId: string;
  workspaceName: string;
}) {
  const [result, setResult] = useState<MaintenanceTickResponse | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const runMaintenance = useApiAction<unknown>({
    call: () =>
      fetch(`/api/workspaces/${workspaceId}/maintenance/tick`, {
        method: "POST",
      }),
    errorText: "Could not run maintenance. Try again later.",
    onSuccess: (payload) => {
      const parsed = maintenanceTickResponseSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Maintenance results are unavailable. Try again later.");
      setResult(parsed.data);
      setMessage(resultMessage(parsed.data));
    },
    setFlashMessage: setMessage,
  });

  return (
    <div className="space-y-4 rounded-[6px] border border-border bg-sheet px-5 py-4">
      <p className="max-w-2xl break-words text-[13px] leading-5 text-muted">
        This pass runs only in{" "}
        <strong className="font-medium text-foreground">{workspaceName}</strong>. It can retry
        stalled jobs, mark jobs as failed, stop their sandboxes, and archive sessions linked to
        closed Linear issues. GitHub verification runs in batches. The scheduled worker handles
        orphaned sandboxes separately.
      </p>
      <button
        type="button"
        className="ui-button-primary gap-1.5"
        disabled={runMaintenance.isBusy}
        onClick={() => {
          setResult(null);
          setMessage(null);
          void runMaintenance.run();
        }}
      >
        <ActionButtonLabel
          idle="Run maintenance"
          pending={runMaintenance.isBusy}
          pendingLabel="Running…"
        />
      </button>
      <InlineActionMessage message={message} />
      {result ? (
        <dl className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {result.cleanup ? (
            <>
              <SummaryCell
                label="Stalled runs marked failed"
                value={result.cleanup.stalledRunIds.length}
              />
              <SummaryCell
                label="Jobs queued for retry"
                value={result.cleanup.retriedJobIds.length}
              />
              <SummaryCell
                label="Jobs marked failed"
                value={result.cleanup.terminalErroredJobIds.length}
              />
              <SummaryCell
                label="Stalled-run sandboxes stopped"
                value={result.cleanup.stoppedSandboxIds.length}
              />
            </>
          ) : null}
          {result.reconciliation ? (
            <>
              <SummaryCell
                label="Linear-linked sessions checked"
                value={result.reconciliation.checked}
              />
              <SummaryCell
                label="Linear-linked sessions archived"
                value={result.reconciliation.canceled}
              />
            </>
          ) : null}
          {result.githubVerification ? (
            <>
              <SummaryCell
                label="GitHub checks attempted"
                value={result.githubVerification.checked}
              />
              <SummaryCell
                label="GitHub checks refreshed"
                value={result.githubVerification.refreshed}
              />
              <SummaryCell label="GitHub checks failed" value={result.githubVerification.failed} />
            </>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
