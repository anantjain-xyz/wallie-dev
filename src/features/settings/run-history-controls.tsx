"use client";

import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { readResponseJson, useApiAction } from "@/features/settings/use-api-action";
import {
  MAX_RUN_RETENTION_DAYS,
  runExportListResponseSchema,
  runExportResponseSchema,
  runRetentionResponseSchema,
  runRetentionSchema,
  type RunExportSummary,
  type RunRetention,
} from "@/lib/run-exports/contracts";

const retentionFields = [
  { key: "transcriptDays", label: "Transcript", content: "Transcripts" },
  { key: "evidenceDays", label: "Validation evidence", content: "Validation evidence" },
  { key: "contextDays", label: "Historical context", content: "Historical context" },
] as const;

type RetentionDraft = Record<keyof RunRetention, string>;
const retentionNumber = new Intl.NumberFormat();

function formatLimit(days: number | null) {
  if (days === null) return "Keep indefinitely";
  return `${retentionNumber.format(days)} ${days === 1 ? "day" : "days"}`;
}

function tightenedFields(saved: RunRetention, next: RunRetention) {
  return retentionFields.filter(({ key }) => {
    const previous = saved[key];
    const limit = next[key];
    return limit !== null && (previous === null || limit < previous);
  });
}

function toDraft(policy: RunRetention): RetentionDraft {
  return {
    transcriptDays: policy.transcriptDays === null ? "" : String(policy.transcriptDays),
    evidenceDays: policy.evidenceDays === null ? "" : String(policy.evidenceDays),
    contextDays: policy.contextDays === null ? "" : String(policy.contextDays),
  };
}

function RetentionControls({ url, onSaved }: { url: string; onSaved: () => void }) {
  const [draft, setDraft] = useState<RetentionDraft | null>(null);
  const [savedPolicy, setSavedPolicy] = useState<RunRetention | null>(null);
  const [policyToConfirm, setPolicyToConfirm] = useState<RunRetention | null>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const hintId = useId();
  const saveButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
        const { retention } = runRetentionResponseSchema.parse(await readResponseJson(response));
        if (!controller.signal.aborted) {
          setSavedPolicy(retention);
          setDraft(toDraft(retention));
        }
      } catch {
        if (!controller.signal.aborted) {
          setMessage({ kind: "error", text: "Could not load run retention." });
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [url, revision]);

  const save = useApiAction<unknown, [RunRetention]>({
    call: (policy) =>
      fetch(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(policy),
      }),
    errorText: "Could not save run retention.",
    onSuccess: (payload) => {
      const { retention } = runRetentionResponseSchema.parse(payload);
      setSavedPolicy(retention);
      setDraft(toDraft(retention));
      setPolicyToConfirm(null);
      onSaved();
    },
    setFlashMessage: setMessage,
    successText: "Retention saved. The worker will apply it to eligible content.",
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!draft || !savedPolicy || policyToConfirm || save.isBusy) return;
    setMessage(null);
    const policy = runRetentionSchema.safeParse({
      transcriptDays: draft.transcriptDays === "" ? null : Number(draft.transcriptDays),
      evidenceDays: draft.evidenceDays === "" ? null : Number(draft.evidenceDays),
      contextDays: draft.contextDays === "" ? null : Number(draft.contextDays),
    });
    if (!policy.success) {
      setMessage({ kind: "error", text: "Check the retention limits." });
      return;
    }
    if (tightenedFields(savedPolicy, policy.data).length > 0) {
      setPolicyToConfirm(policy.data);
    } else {
      void save.run(policy.data);
    }
  }

  const tightened =
    savedPolicy && policyToConfirm ? tightenedFields(savedPolicy, policyToConfirm) : [];
  const expiresExports = tightened.some(({ key }) => key !== "contextDays");

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-[15px] font-semibold text-foreground">Retention</h3>
        <p className="max-w-2xl text-[13px] leading-5 text-muted">
          Validation retention protects required evidence for unarchived sessions. Historical
          context retention permanently erases older document revisions and unimported proposals
          from finished runs. Current document bodies stay available while their source is active.
        </p>
      </div>
      {draft ? (
        <form aria-label="Run retention" className="space-y-4" onSubmit={submit}>
          <p className="text-[13px] text-muted" id={hintId}>
            Enter 1–{retentionNumber.format(MAX_RUN_RETENTION_DAYS)} whole days, or leave blank to
            keep indefinitely.
          </p>
          <fieldset className="grid gap-4 sm:grid-cols-2" disabled={save.isBusy}>
            <legend className="sr-only">Retention limits</legend>
            {retentionFields.map(({ key, label }) => (
              <label className="block min-w-0 space-y-1.5 text-[13px] font-medium" key={key}>
                <span>{label} retention (days)</span>
                <input
                  aria-describedby={hintId}
                  autoComplete="off"
                  className="ui-input"
                  max={MAX_RUN_RETENTION_DAYS}
                  min={1}
                  name={key}
                  onChange={(event) => {
                    const value = event.currentTarget.value;
                    setDraft((current) => current && { ...current, [key]: value });
                    setMessage(null);
                  }}
                  step={1}
                  type="number"
                  value={draft[key]}
                />
              </label>
            ))}
          </fieldset>
          <button
            className="ui-button-primary"
            disabled={save.isBusy}
            ref={saveButtonRef}
            type="submit"
          >
            <ActionButtonLabel idle="Save retention" pending={save.isBusy} pendingLabel="Saving…" />
          </button>
        </form>
      ) : message?.kind === "error" ? (
        <button
          className="ui-button-secondary"
          onClick={() => {
            setMessage(null);
            setRevision((current) => current + 1);
          }}
          type="button"
        >
          Retry loading retention
        </button>
      ) : (
        <p className="text-sm text-muted" role="status">
          Loading retention…
        </p>
      )}
      <InlineActionMessage message={policyToConfirm ? null : message} />
      {policyToConfirm && savedPolicy ? (
        <DestructiveConfirmationDialog
          actionLabel="Apply retention limits"
          description={
            <>
              Shorter limits apply to existing content. Wallie can permanently remove eligible
              content older than the new limits.
              {expiresExports
                ? " This change immediately expires in-progress and completed workspace exports, including their download links."
                : null}
            </>
          }
          errorMessage={message?.kind === "error" ? message.text : null}
          onConfirm={() => {
            setMessage(null);
            void save.run(policyToConfirm);
          }}
          onOpenChange={(open) => {
            if (!open) {
              setPolicyToConfirm(null);
              setMessage(null);
            }
          }}
          open
          pending={save.isBusy}
          pendingLabel="Applying…"
          restoreFocusRef={saveButtonRef}
          title="Tighten retention limits?"
        >
          <ul className="space-y-2 border-t border-border pt-3 text-sm tabular-nums">
            {tightened.map(({ key, content }) => (
              <li key={key}>
                <span className="font-medium text-foreground">{content}: </span>
                <span className="text-muted">
                  {formatLimit(savedPolicy[key])} → {formatLimit(policyToConfirm[key])}
                </span>
              </li>
            ))}
          </ul>
        </DestructiveConfirmationDialog>
      ) : null}
    </div>
  );
}

const exportDate = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const statusLabel = {
  queued: "Queued",
  running: "In progress",
  completed: "Complete",
  failed: "Failed",
  expired: "Expired",
} satisfies Record<RunExportSummary["status"], string>;

function isPending(job: RunExportSummary) {
  return job.status === "queued" || job.status === "running";
}

function ExportControls({ url, policyVersion }: { url: string; policyVersion: number }) {
  const [jobs, setJobs] = useState<RunExportSummary[] | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [loadError, setLoadError] = useState<FlashMessage | null>(null);
  const [actionMessage, setActionMessage] = useState<FlashMessage | null>(null);
  const pendingRequest = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      try {
        const response = await fetch(url, { cache: "no-store", signal: controller.signal });
        const { exports } = runExportListResponseSchema.parse(await readResponseJson(response));
        if (controller.signal.aborted) return;
        setJobs(exports);
        setLoadError(null);
        if (exports.some(isPending)) timer = setTimeout(() => void load(), 5000);
      } catch {
        if (!controller.signal.aborted) {
          setJobs(null);
          setLoadError({ kind: "error", text: "Could not load run exports." });
        }
      }
    }

    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [url, refresh, policyVersion]);

  const request = useApiAction({
    call: async () => {
      const requestId = pendingRequest.current ?? crypto.randomUUID();
      pendingRequest.current = requestId;
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId }),
      });
      if (response.status === 409) setRefresh((current) => current + 1);
      return response;
    },
    errorText: "Could not request an export.",
    onSuccess: (payload) => {
      const { export: job } = runExportResponseSchema.parse(payload);
      pendingRequest.current = null;
      setJobs((current) => [job, ...(current ?? []).filter((item) => item.id !== job.id)]);
      setRefresh((current) => current + 1);
    },
    setFlashMessage: setActionMessage,
    successText: "Export requested. You can close this page while the worker prepares it.",
  });

  return (
    <div className="space-y-4 border-t border-border pt-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h3 className="text-[15px] font-semibold text-foreground">Exports</h3>
          <p className="max-w-xl text-[13px] leading-5 text-muted">
            Export retained run history, transcript pages, and artifact evidence with a manifest
            that records capture gaps and unavailable content.
          </p>
        </div>
        <button
          className="ui-button-primary"
          disabled={!jobs || request.isBusy || jobs.some(isPending)}
          onClick={() => {
            setActionMessage(null);
            void request.run();
          }}
          type="button"
        >
          <ActionButtonLabel
            idle="Request export"
            pending={request.isBusy}
            pendingLabel="Requesting…"
          />
        </button>
      </div>
      <InlineActionMessage message={actionMessage} />
      <InlineActionMessage message={loadError} />
      {loadError ? (
        <button
          className="ui-button-secondary"
          onClick={() => {
            setLoadError(null);
            setRefresh((current) => current + 1);
          }}
          type="button"
        >
          Retry loading exports
        </button>
      ) : jobs === null ? (
        <p className="text-sm text-muted" role="status">
          Loading exports…
        </p>
      ) : jobs.length ? (
        <ul aria-label="Recent run exports" className="divide-y divide-border">
          {jobs.map((job) => (
            <li className="flex flex-wrap items-center justify-between gap-3 py-3" key={job.id}>
              <div className="min-w-0 space-y-0.5">
                <p className="text-sm font-medium text-foreground" id={`run-export-time-${job.id}`}>
                  Export requested{" "}
                  <time dateTime={job.requestedAt}>
                    {exportDate.format(new Date(job.requestedAt))}
                  </time>
                </p>
                <p aria-live="polite" className="text-xs text-muted">
                  {statusLabel[job.status]}
                  {job.status === "running" && job.itemCount
                    ? ` · ${job.processedCount} of ${job.itemCount} records`
                    : null}
                  {job.status === "completed" ? (
                    <>
                      {" · Expires "}
                      <time dateTime={job.expiresAt}>
                        {exportDate.format(new Date(job.expiresAt))}
                      </time>
                    </>
                  ) : null}
                </p>
              </div>
              {job.status === "completed" ? (
                <a
                  aria-describedby={`run-export-time-${job.id}`}
                  className="ui-button-secondary"
                  href={`${url}/${job.id}`}
                >
                  Download manifest
                </a>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">No exports yet.</p>
      )}
    </div>
  );
}

export function RunHistoryControls({ workspaceId }: { workspaceId: string }) {
  return <WorkspaceRunHistoryControls key={workspaceId} workspaceId={workspaceId} />;
}

function WorkspaceRunHistoryControls({ workspaceId }: { workspaceId: string }) {
  const [policyVersion, setPolicyVersion] = useState(0);
  const base = `/api/workspaces/${workspaceId}`;
  return (
    <div className="ui-sheet space-y-5 p-5">
      <RetentionControls
        onSaved={() => setPolicyVersion((version) => version + 1)}
        url={`${base}/run-retention`}
      />
      <ExportControls policyVersion={policyVersion} url={`${base}/run-exports`} />
    </div>
  );
}
