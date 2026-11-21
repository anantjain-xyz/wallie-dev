"use client";

import { useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { MetadataItem, MetadataList } from "@/components/ui/page-shell";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkCapturePreviewSchema,
  benchmarkCaptureRequestSchema,
  benchmarkCaptureResultSchema,
  type BenchmarkCapturePreview,
  type BenchmarkCaptureRequest,
  type BenchmarkCaptureResult,
} from "@/lib/factory-benchmarks/capture-contracts";

type CaptureView =
  | { kind: "closed" | "loading" | "unavailable" | "denied" }
  | { kind: "ready"; preview: BenchmarkCapturePreview; refresh: "idle" | "required" | "pending" }
  | { kind: "saved"; result: BenchmarkCaptureResult };

function SnapshotPreview({ source }: { source: BenchmarkCapturePreview["source"] }) {
  const inputs = [
    ["Starting checkout", source.checkoutSha],
    ["Retained ref", source.inputRef],
    ["Factory definition revision", source.definitionRevisionId],
    ["Context manifest SHA-256", source.contextManifestSha],
    ["Rendered prompt SHA-256", source.recordedPromptSha],
  ];

  return (
    <section className="space-y-3" aria-label="Snapshot preview">
      <h3 className="type-label text-foreground">Snapshot preview</h3>
      <p className="type-secondary break-words text-foreground">{source.name}</p>
      {source.eligibility.status === "eligible" ? (
        <p className="type-secondary font-medium text-success">Eligible for replay</p>
      ) : (
        <div className="rounded-md border border-warning/20 bg-warning-soft p-3 text-warning">
          <p className="type-secondary font-medium">Ineligible for replay</p>
          <ul className="type-secondary mt-1 list-disc space-y-1 pl-4">
            {source.eligibility.reasons.map((reason) => (
              <li className="break-words" key={reason}>
                {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
      <MetadataList className="sm:grid-cols-1">
        {inputs.map(([label, value]) => (
          <MetadataItem
            key={label}
            label={label}
            value={
              value ? <code className="[overflow-wrap:anywhere]">{value}</code> : "Not recorded"
            }
          />
        ))}
      </MetadataList>
      <details className="rounded-md border border-border">
        <summary className="type-label cursor-pointer px-3 py-2.5">Original prompt</summary>
        <p className="type-secondary whitespace-pre-wrap px-3 pb-3 [overflow-wrap:anywhere]">
          {source.originalPrompt ?? "Original prompt unavailable."}
        </p>
      </details>
    </section>
  );
}

export function CaptureBenchmarkRun({
  workspaceId,
  runId,
}: {
  workspaceId: string;
  runId: string;
}) {
  const [view, setView] = useState<CaptureView>({ kind: "closed" });
  const [suiteId, setSuiteId] = useState("");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const newSuiteId = useRef<string | null>(null);
  const endpoint = `/api/workspaces/${workspaceId}/runs/${runId}/benchmark`;

  async function loadPreview({ preserveDraft = false } = {}) {
    previewRequest.current?.abort();
    const controller = new AbortController();
    previewRequest.current = controller;
    setMessage(null);
    setView((current) =>
      preserveDraft && current.kind === "ready"
        ? { ...current, refresh: "pending" }
        : { kind: "loading" },
    );

    try {
      const response = await fetch(endpoint, { cache: "no-store", signal: controller.signal });
      if (response.status === 403) {
        controller.signal.throwIfAborted();
        setView({ kind: "denied" });
        return;
      }
      if (!response.ok) throw new Error("Benchmark preview unavailable.");
      const payload: unknown = await response.json();
      const preview = benchmarkCapturePreviewSchema.parse(payload);
      controller.signal.throwIfAborted();
      setSuiteId((current) =>
        current === "new" || preview.suites.some(({ id }) => id === current) ? current : "",
      );
      setView({ kind: "ready", preview, refresh: "idle" });
    } catch {
      if (controller.signal.aborted) return;
      if (preserveDraft) {
        setMessage({ kind: "error", text: "Could not refresh the snapshot preview." });
        setView((current) =>
          current.kind === "ready" ? { ...current, refresh: "required" } : current,
        );
      } else {
        setView({ kind: "unavailable" });
      }
    }
  }

  const action = useApiAction<unknown, [BenchmarkCaptureRequest]>({
    async call(command) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(command),
      });
      if (response.status === 403) setView({ kind: "denied" });
      if (response.status === 409) {
        setView((current) =>
          current.kind === "ready" ? { ...current, refresh: "required" } : current,
        );
        throw new Error("The benchmark changed. Refresh the preview before saving again.");
      }
      return response;
    },
    errorText: "Could not save the benchmark task.",
    setFlashMessage: setMessage,
    onSuccess(payload) {
      setView({ kind: "saved", result: benchmarkCaptureResultSchema.parse(payload) });
    },
  });

  function changeOpen(open: boolean) {
    if (open) {
      void loadPreview();
      return;
    }
    if (action.isBusy) return;
    previewRequest.current?.abort();
    newSuiteId.current = null;
    setSuiteId("");
    setView({ kind: "closed" });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view.kind !== "ready" || view.refresh !== "idle") return;
    const fields = new FormData(event.currentTarget);
    const choice = fields.get("suite");
    const suite = view.preview.suites.find(({ id }) => id === choice);
    const request = benchmarkCaptureRequestSchema.safeParse({
      acceptanceCriteria: view.preview.existingTask ? undefined : fields.get("acceptanceCriteria"),
      expectedTaskRevisionId: view.preview.existingTask?.revisionId,
      suite:
        choice === "new"
          ? {
              kind: "new",
              id: (newSuiteId.current ??= crypto.randomUUID()),
              name: fields.get("name"),
              purpose: fields.get("purpose"),
            }
          : suite && { kind: "existing", id: suite.id, revisionId: suite.revisionId },
    });
    if (!request.success) {
      setMessage({
        kind: "error",
        text: "Choose a suite and enter its name if new. Acceptance criteria are required.",
      });
      return;
    }
    setMessage(null);
    void action.run(request.data);
  }

  const selection = suiteId || (view.kind === "ready" && !view.preview.suites.length ? "new" : "");

  return (
    <Dialog open={view.kind !== "closed"} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <button className="ui-button" type="button">
          Add to benchmark
        </button>
      </DialogTrigger>
      <DialogContent title="Add to benchmark" dismissible={!action.isBusy}>
        {view.kind === "loading" ? (
          <p className="type-secondary text-muted" role="status">
            Loading snapshot preview…
          </p>
        ) : null}
        {view.kind === "unavailable" ? (
          <div className="space-y-3">
            <InlineActionMessage
              message={{ kind: "error", text: "Could not load the snapshot preview." }}
            />
            <button className="ui-button" type="button" onClick={() => void loadPreview()}>
              Retry
            </button>
          </div>
        ) : null}
        {view.kind === "denied" ? (
          <InlineActionMessage
            message={{
              kind: "error",
              text: "You need permission to manage this factory to add runs to benchmarks.",
            }}
          />
        ) : null}
        {view.kind === "saved" ? (
          <>
            <InlineActionMessage
              message={{
                kind: "success",
                text: view.result.added
                  ? "Run added to the benchmark suite."
                  : "This run is already in the benchmark suite.",
              }}
            />
            <DialogFooter>
              <DialogClose className="ui-button ui-button-primary">Close</DialogClose>
            </DialogFooter>
          </>
        ) : null}
        {view.kind === "ready" ? (
          <div className="space-y-5">
            <SnapshotPreview source={view.preview.source} />
            <form className="space-y-4" onSubmit={submit}>
              <InlineActionMessage message={message} />
              {view.refresh !== "idle" ? (
                <button
                  className="ui-button"
                  type="button"
                  disabled={view.refresh === "pending"}
                  onClick={() => void loadPreview({ preserveDraft: true })}
                >
                  {view.refresh === "pending" ? "Refreshing preview…" : "Refresh preview"}
                </button>
              ) : null}
              <fieldset
                className="min-w-0 space-y-4"
                aria-busy={action.isBusy || view.refresh === "pending"}
                disabled={action.isBusy || view.refresh === "pending"}
              >
                <legend className="sr-only">Benchmark task</legend>
                <label className="block space-y-1.5">
                  <span className="type-label">Suite</span>
                  <select
                    className="ui-select"
                    name="suite"
                    value={selection}
                    onChange={(event) => setSuiteId(event.target.value)}
                    required
                  >
                    <option value="" disabled>
                      Choose a suite
                    </option>
                    {view.preview.suites.map((suite) => (
                      <option key={suite.id} value={suite.id}>
                        {suite.name}
                      </option>
                    ))}
                    <option value="new">New suite</option>
                  </select>
                </label>
                {selection === "new" ? (
                  <div className="grid gap-4 sm:grid-cols-2">
                    <label className="block min-w-0 space-y-1.5">
                      <span className="type-label">Suite name</span>
                      <input className="ui-input" name="name" maxLength={120} required />
                    </label>
                    <label className="block min-w-0 space-y-1.5">
                      <span className="type-label">Suite purpose</span>
                      <select className="ui-select" name="purpose" defaultValue="regression">
                        <option value="regression">Regression</option>
                        <option value="holdout">Holdout</option>
                      </select>
                    </label>
                  </div>
                ) : null}
                <label className="block space-y-1.5">
                  <span className="type-label">Acceptance criteria</span>
                  <textarea
                    className="ui-textarea"
                    name="acceptanceCriteria"
                    rows={4}
                    maxLength={20_000}
                    key={view.preview.existingTask?.id ?? "draft"}
                    value={view.preview.existingTask?.acceptanceCriteria}
                    readOnly={view.preview.existingTask !== null}
                    required={view.preview.existingTask === null}
                  />
                </label>
                {view.preview.existingTask ? (
                  <p className="type-secondary text-muted">
                    This run already has a benchmark task. Adding it reuses these criteria.
                  </p>
                ) : null}
                <button
                  className="ui-button ui-button-primary"
                  type="submit"
                  disabled={view.refresh !== "idle"}
                >
                  <ActionButtonLabel
                    idle="Save to benchmark"
                    pending={action.isBusy}
                    pendingLabel="Saving…"
                  />
                </button>
              </fieldset>
            </form>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
