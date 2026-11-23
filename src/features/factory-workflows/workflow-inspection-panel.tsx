"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Status } from "@/components/ui/status";
import {
  type WorkflowInspection,
  type WorkflowInspectionHeader,
  workflowInspectionSchema,
} from "@/lib/factory-workflows/inspection-contracts";
import {
  workflowInspectionApiPath,
  workspaceSessionDetailPath,
  workspaceWorkflowDetailPath,
} from "@/lib/routes";

import { WorkflowInspectionBudget } from "./workflow-inspection-budget";
import { WorkflowInspectionTimeline } from "./workflow-inspection-timeline";

type LifecycleAction = "pause" | "resume" | "cancel";
type WorkflowIntent = {
  action: LifecycleAction;
  expectedGeneration: number;
  requestId: string;
};
type Operation = "refresh" | "older" | LifecycleAction;
type Notice = { role: "status" | "alert"; message: string };

const lifecycleReceiptSchema = z.object({
  action: z.enum(["pause", "resume", "cancel"]),
  requestId: z.string().uuid(),
  generation: z.number().int().safe().positive(),
  lifecycleStatus: z.enum(["running", "paused", "canceled"]),
});
const actionResult = {
  pause: { status: "paused", message: "Workflow paused." },
  resume: { status: "running", message: "Workflow resumed." },
  cancel: { status: "canceled", message: "Workflow canceled." },
} satisfies Record<LifecycleAction, { status: string; message: string }>;

class InspectionReadError extends Error {
  constructor(readonly status: number) {
    super("Could not load the workflow.");
  }
}

function appendPage(item: WorkflowInspection, older: WorkflowInspection): WorkflowInspection {
  const previousIds = new Set(item.events.map(({ kind, id }) => `${kind}:${id}`));
  return {
    ...older,
    budget: older.budget ?? item.budget,
    events: [
      ...item.events,
      ...older.events.filter(({ kind, id }) => !previousIds.has(`${kind}:${id}`)),
    ],
  };
}

function useWorkflowInspection(header: WorkflowInspectionHeader) {
  const { sessionId, runId } = header.subject;
  const { sessionId: rootId, workspaceId, factoryId, graphRevisionId } = header.root;
  const [inspection, setInspection] = useState<WorkflowInspection | null>(null);
  const [operation, setOperation] = useState<Operation | null>("refresh");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const active = useRef<AbortController | null>(null);
  const retry = useRef<WorkflowIntent | null>(null);

  const run = useCallback(async (next: Operation, work: (signal: AbortSignal) => Promise<void>) => {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setOperation(next);
    try {
      await work(controller.signal);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setOperation(null);
      }
    }
  }, []);

  const read = useCallback(
    async (signal: AbortSignal, cursor?: string) => {
      setReadError(null);
      try {
        const response = await fetch(
          workflowInspectionApiPath(sessionId, { runId: runId ?? undefined, cursor }),
          { cache: "no-store", signal },
        );
        if (!response.ok) throw new InspectionReadError(response.status);
        const page = workflowInspectionSchema.parse(await response.json());
        signal.throwIfAborted();
        if (
          page.root.sessionId !== rootId ||
          page.root.workspaceId !== workspaceId ||
          page.root.factoryId !== factoryId ||
          page.root.graphRevisionId !== graphRevisionId ||
          page.subject.sessionId !== sessionId ||
          page.subject.runId !== runId
        ) {
          throw new Error("Workflow inspection identity changed.");
        }
        setInspection((previous) => (cursor && previous ? appendPage(previous, page) : page));
        setRefreshRequired(false);
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof InspectionReadError && [401, 403, 404].includes(error.status)) {
          setInspection(null);
          setReadError("Workflow inspection is unavailable.");
        } else {
          setReadError("Could not load the workflow.");
        }
      }
    },
    [factoryId, graphRevisionId, rootId, runId, sessionId, workspaceId],
  );

  const refresh = useCallback(() => void run("refresh", read), [read, run]);
  useEffect(() => {
    refresh();
    return () => {
      active.current?.abort();
      active.current = null;
    };
  }, [refresh]);

  function loadOlder() {
    const cursor = inspection?.nextCursor;
    if (cursor) void run("older", (signal) => read(signal, cursor));
  }

  function changeLifecycle(action: LifecycleAction) {
    const root = inspection?.root;
    if (!root?.canManage || refreshRequired || root.lifecycleStatus === "canceled") return;
    if (
      (action === "pause" && root.lifecycleStatus !== "running") ||
      (action === "resume" && root.lifecycleStatus !== "paused")
    )
      return;

    void run(action, async (signal) => {
      setNotice(null);
      const previous = retry.current;
      const intent =
        previous?.action === action && previous.expectedGeneration === root.generation
          ? previous
          : { action, expectedGeneration: root.generation, requestId: crypto.randomUUID() };
      retry.current = intent;
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(rootId)}/workflow-lifecycle`,
          {
            method: "POST",
            cache: "no-store",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(intent),
            signal,
          },
        );
        signal.throwIfAborted();
        if (response.status === 409) {
          retry.current = null;
          setRefreshRequired(true);
          setNotice({
            role: "alert",
            message: "The workflow changed. Review its current state before choosing an action.",
          });
          await read(signal);
          return;
        }
        if (!response.ok) {
          if (response.status < 500) retry.current = null;
          if ([401, 403, 404].includes(response.status)) {
            setRefreshRequired(true);
            await read(signal);
          }
          throw new Error("Could not update the workflow.");
        }
        const receipt = lifecycleReceiptSchema.parse(await response.json());
        signal.throwIfAborted();
        if (
          receipt.requestId !== intent.requestId ||
          receipt.action !== action ||
          receipt.generation !== intent.expectedGeneration + 1 ||
          receipt.lifecycleStatus !== actionResult[action].status
        ) {
          throw new Error("Could not verify the workflow command receipt.");
        }
        retry.current = null;
        setInspection((page) =>
          page && page.root.generation <= receipt.generation
            ? {
                ...page,
                root: {
                  ...page.root,
                  generation: receipt.generation,
                  lifecycleStatus: receipt.lifecycleStatus,
                },
              }
            : page,
        );
        setNotice({ role: "status", message: actionResult[action].message });
        await read(signal);
      } catch {
        if (!signal.aborted)
          setNotice({ role: "alert", message: "Could not update the workflow. Try again." });
      }
    });
  }

  return {
    inspection,
    operation,
    notice,
    readError,
    refreshRequired,
    refresh,
    loadOlder,
    changeLifecycle,
  };
}

export function WorkflowInspectionPanel({
  header,
  initialNow,
  workspaceSlug,
}: {
  header: WorkflowInspectionHeader;
  initialNow: string;
  workspaceSlug: string;
}) {
  const view = useWorkflowInspection(header);
  const root = view.inspection?.root;
  const canChange = Boolean(root?.canManage && root.lifecycleStatus !== "canceled");
  const working = view.operation !== null;
  const disabled = working || view.refreshRequired;
  return (
    <div className="min-w-0 space-y-5 rounded-md border border-border bg-sheet p-3 text-sm sm:p-5">
      {root ? (
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Link
                className="font-medium text-accent underline underline-offset-4"
                href={workspaceSessionDetailPath(workspaceSlug, root.sessionNumber)}
                prefetch={false}
              >
                Workflow root · Session #{root.sessionNumber}
              </Link>
              <Status
                compact
                value={root.lifecycleStatus === "paused" ? "upcoming" : root.lifecycleStatus}
                label={root.lifecycleStatus === "paused" ? "Paused" : undefined}
              />
            </div>
            <button className="ui-button" disabled={working} type="button" onClick={view.refresh}>
              Refresh workflow
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
            <span>
              Workflow revision{" "}
              <code className="font-mono" title={root.workflowDigest}>
                {root.workflowDigest.slice(0, 12)}
              </code>
            </span>
            <span>Generation {root.generation}</span>
            {header.subject.sessionId !== root.sessionId ? (
              <span>Inspecting session #{header.subject.sessionNumber}</span>
            ) : null}
            {root.canManage && root.workflowId ? (
              <Link
                className="text-accent underline underline-offset-4"
                href={workspaceWorkflowDetailPath(workspaceSlug, root.workflowId, {
                  factory: root.factoryId,
                })}
                prefetch={false}
              >
                Open workflow settings
              </Link>
            ) : null}
          </div>
          {canChange ? (
            <div aria-label="Workflow lifecycle actions" className="flex flex-wrap gap-2">
              <button
                className="ui-button"
                disabled={disabled}
                type="button"
                onClick={() =>
                  view.changeLifecycle(root.lifecycleStatus === "paused" ? "resume" : "pause")
                }
              >
                {root.lifecycleStatus === "paused" ? "Resume workflow" : "Pause workflow"}
              </button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <button className="ui-button" disabled={disabled} type="button">
                    Cancel workflow
                  </button>
                </AlertDialogTrigger>
                <AlertDialogContent
                  title="Cancel this workflow?"
                  description="Cancellation ends active work for the workflow and its children. Existing receipts remain available."
                >
                  <AlertDialogFooter>
                    <AlertDialogCancel className="ui-button">Keep workflow</AlertDialogCancel>
                    <AlertDialogAction
                      className="ui-button-danger"
                      onClick={() => view.changeLifecycle("cancel")}
                    >
                      Cancel workflow
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          ) : null}
        </header>
      ) : null}
      {view.notice ? (
        <p className="text-sm" role={view.notice.role}>
          {view.notice.message}
        </p>
      ) : null}
      {view.readError ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-danger" role="alert">
            {view.readError}
          </p>
          <button className="ui-button" disabled={working} onClick={view.refresh} type="button">
            Retry workflow read
          </button>
        </div>
      ) : null}
      {view.operation === "refresh" ? (
        <p className="text-muted" role="status">
          Loading workflow…
        </p>
      ) : null}
      {view.inspection ? (
        <>
          {view.inspection.budget ? (
            <WorkflowInspectionBudget budget={view.inspection.budget} />
          ) : null}
          <WorkflowInspectionTimeline
            events={view.inspection.events}
            initialNow={initialNow}
            subject={view.inspection.subject}
            workspaceSlug={workspaceSlug}
          />
          {view.inspection.nextCursor ? (
            <button className="ui-button" disabled={working} type="button" onClick={view.loadOlder}>
              {view.operation === "older" ? "Loading older events…" : "Load older events"}
            </button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
