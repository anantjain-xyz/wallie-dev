"use client";

import { useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";

import {
  type AnalyticsExportFilters,
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
  const [snapshot, setSnapshot] = useState<AnalyticsExportReceipt | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const requestId = useRef<string | null>(null);
  const endpoint = factoryAnalyticsExportsPath(workspaceId, factoryId);

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
      setSnapshot(receipt.data);
    },
    errorText: "Could not create the analytics export.",
    setFlashMessage: setMessage,
  });

  const download = snapshot ? endpoint + "/" + encodeURIComponent(snapshot.id) : null;
  return (
    <section
      aria-labelledby="analytics-export-heading"
      className="ui-sheet mb-6 space-y-3 px-4 py-4 sm:px-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1">
          <h2 className="type-section-title" id="analytics-export-heading">
            Export analytics
          </h2>
          <p className="type-secondary text-muted">
            Save the applied date ranges, metric totals, and supporting observations.
          </p>
        </div>
        <button
          className="ui-button px-3 py-2 text-sm"
          disabled={action.isBusy}
          onClick={() => {
            setMessage(null);
            void action.run();
          }}
          type="button"
        >
          <ActionButtonLabel
            idle="Create export snapshot"
            pending={action.isBusy}
            pendingLabel="Creating snapshot…"
          />
        </button>
      </div>
      <InlineActionMessage message={message} />
      {snapshot && download && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border pt-3">
          <p className="type-secondary text-muted" role="status">
            Captured{" "}
            <time dateTime={snapshot.createdAt}>
              {dateTime.format(new Date(snapshot.createdAt))}
            </time>
            . Expires{" "}
            <time dateTime={snapshot.expiresAt}>
              {dateTime.format(new Date(snapshot.expiresAt))}
            </time>
            .
          </p>
          <a className="ui-button px-3 py-2 text-sm" href={download + "?format=csv"}>
            Download CSV
          </a>
          <a className="ui-button px-3 py-2 text-sm" href={download + "?format=json"}>
            Download JSON
          </a>
        </div>
      )}
    </section>
  );
}
