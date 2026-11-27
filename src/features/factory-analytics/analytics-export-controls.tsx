"use client";

import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

import {
  type AnalyticsExportFilters,
  type AnalyticsExportFormat,
  type AnalyticsExportReceipt,
  analyticsExportReceiptSchema,
  factoryAnalyticsExportsPath,
} from "./analytics-export-contracts";

const dateTime = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  timeZoneName: "short",
  year: "numeric",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

export function AnalyticsExportControls({
  workspaceId,
  factoryId,
  filters,
}: {
  workspaceId: string;
  factoryId: string;
  filters: AnalyticsExportFilters;
}) {
  const [capture, setCapture] = useState<{
    receipt: AnalyticsExportReceipt;
    expired: boolean;
  } | null>(null);
  const [snapshotUnavailable, setSnapshotUnavailable] = useState(false);
  const [downloading, setDownloading] = useState<AnalyticsExportFormat | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const requestId = useRef<string | null>(null);
  const endpoint = factoryAnalyticsExportsPath(workspaceId, factoryId);
  const snapshot = capture?.receipt ?? null;
  const expired = capture?.expired ?? false;

  const action = useApiAction({
    call: async () => {
      const id = requestId.current ?? crypto.randomUUID();
      requestId.current = id;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...filters, requestId: id }),
      }).catch(() => {
        throw new Error("Connection interrupted. Retry to recover the export request.");
      });
      if (response.status === 410) requestId.current = null;
      return response;
    },
    onSuccess: (payload) => {
      const receipt = analyticsExportReceiptSchema.safeParse(payload);
      if (!receipt.success)
        throw new Error("Could not read the export receipt. Retry the request.");
      requestId.current = null;
      setCapture({
        receipt: receipt.data,
        expired: Date.parse(receipt.data.expiresAt) <= Date.now(),
      });
      setSnapshotUnavailable(false);
    },
    errorText: "Could not create the analytics export.",
    setFlashMessage: setMessage,
  });

  useEffect(() => {
    if (!snapshot || expired) return;
    const timer = window.setTimeout(
      () => {
        setCapture((current) =>
          current && current.receipt === snapshot ? { ...current, expired: true } : current,
        );
      },
      Math.max(0, Date.parse(snapshot.expiresAt) - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [snapshot, expired]);

  const download = snapshot ? endpoint + "/" + encodeURIComponent(snapshot.id) : null;
  async function downloadSnapshot(format: AnalyticsExportFormat) {
    if (!snapshot || !download || downloading || action.isBusy) return;
    if (Date.parse(snapshot.expiresAt) <= Date.now()) {
      setCapture({ receipt: snapshot, expired: true });
      return;
    }
    setDownloading(format);
    setMessage(null);
    let objectUrl: string | undefined;
    try {
      const response = await fetch(download + "?format=" + format, { cache: "no-store" });
      if (response.redirected || [401, 403, 404, 410].includes(response.status)) {
        setSnapshotUnavailable(true);
        setMessage({
          kind: "error",
          text: "This snapshot is no longer available. Check your access or create a new snapshot.",
        });
        return;
      }
      if (response.status === 422 && format === "csv") {
        setMessage({
          kind: "error",
          text: "This snapshot is too large for CSV. Download JSON instead.",
        });
        return;
      }
      if (!response.ok || !response.headers.get("Content-Disposition")?.startsWith("attachment;")) {
        throw new Error("Download unavailable");
      }
      objectUrl = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = "wallie-analytics-" + snapshot.id + "." + format;
      link.click();
    } catch {
      setMessage({
        kind: "error",
        text: "Could not download this snapshot. Try downloading again.",
      });
    } finally {
      const url = objectUrl;
      if (url) window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setDownloading(null);
    }
  }

  return (
    <section
      aria-labelledby="analytics-export-heading"
      className="min-w-0 space-y-2 px-4 py-2 sm:px-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h2 className="sr-only" id="analytics-export-heading">
            Export analytics
          </h2>
          <details className="type-secondary text-muted">
            <summary className="w-fit cursor-pointer rounded-sm py-1 font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
              Export scope
            </summary>
            <div className="mt-1 max-w-96 space-y-1">
              <p>
                Factory outcomes for the applied filters. Excludes scorer trends and routing
                canaries. Selecting an evidence facet does not narrow the export.
              </p>
              <p className="type-label">
                {filters.from} to {filters.to} UTC (end excluded) ·{" "}
                {filters.compare ? "Includes previous period" : "Current period only"}
              </p>
            </div>
          </details>
        </div>
        <button
          className="ui-button min-h-9 px-3 py-1.5 text-sm"
          disabled={action.isBusy || downloading !== null}
          onClick={() => {
            setMessage(null);
            void action.run();
          }}
          type="button"
        >
          <ActionButtonLabel
            idle={
              expired || snapshotUnavailable ? "Create a new snapshot" : "Create export snapshot"
            }
            pending={action.isBusy}
            pendingLabel="Creating snapshot…"
          />
        </button>
      </div>
      <InlineActionMessage message={message} />
      {snapshot && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <p className="type-secondary text-muted" role="status">
            {expired ? "Snapshot expired. " : "Captured "}
            {!expired && (
              <>
                <time dateTime={snapshot.createdAt}>
                  {dateTime.format(new Date(snapshot.createdAt))}
                </time>
                . Expires{" "}
                <time dateTime={snapshot.expiresAt}>
                  {dateTime.format(new Date(snapshot.expiresAt))}
                </time>
                .
              </>
            )}
          </p>
          {!expired &&
            !snapshotUnavailable &&
            (["csv", "json"] as const).map((format) => (
              <a
                className="ui-button px-3 py-2 text-sm"
                aria-disabled={downloading !== null || action.isBusy}
                href={download + "?format=" + format}
                key={format}
                onClick={(event) => {
                  event.preventDefault();
                  void downloadSnapshot(format);
                }}
              >
                {downloading === format ? "Downloading…" : "Download " + format.toUpperCase()}
              </a>
            ))}
        </div>
      )}
    </section>
  );
}
