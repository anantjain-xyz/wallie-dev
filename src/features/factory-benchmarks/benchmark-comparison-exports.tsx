"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, type ReactNode } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { PageSection } from "@/components/ui/page-shell";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { type FlashMessage } from "@/features/settings/settings-types";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  benchmarkComparisonExportReceiptSchema,
  type BenchmarkComparisonExportReceipt,
} from "@/lib/factory-benchmarks/comparison-contracts";

const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "UTC",
});
const count = new Intl.NumberFormat("en-US");

function ExportParts({
  href,
  pages,
  kind,
}: {
  href: string;
  pages: number;
  kind: "trials" | "configurations";
}) {
  const [showParts, setShowParts] = useState(false);
  const { label, partLabel, segment } =
    kind === "trials"
      ? { label: "Trial rows", partLabel: "trial", segment: "parts" }
      : { label: "Configuration rows", partLabel: "configuration", segment: "candidate-parts" };
  return (
    <details
      className="rounded-md border border-border"
      onToggle={(event) => setShowParts(event.currentTarget.open)}
    >
      <summary className="type-label cursor-pointer px-3 py-2">
        {label} · {count.format(pages)} {pages === 1 ? "part" : "parts"}
      </summary>
      {showParts ? (
        <ul className="flex flex-wrap gap-2 px-3 pb-3">
          {Array.from({ length: pages }, (_, index) => {
            const ordinal = index + 1;
            return (
              <li key={ordinal}>
                <a className="ui-button" download href={`${href}/${segment}/${ordinal}`}>
                  Download {partLabel} part {ordinal}
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
    </details>
  );
}

function ExportEntry({
  endpoint,
  receipt,
}: {
  endpoint: string;
  receipt: BenchmarkComparisonExportReceipt;
}) {
  const href = `${endpoint}/${encodeURIComponent(receipt.exportId)}`;
  const capturedAt = dateTime.format(new Date(receipt.capturedAt));
  return (
    <li className="space-y-3 px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="type-label">
            <time dateTime={receipt.capturedAt}>{capturedAt} UTC</time>
          </p>
          <p className="type-secondary text-muted">
            {count.format(receipt.trialCount)} {receipt.trialCount === 1 ? "trial" : "trials"} ·
            Expires{" "}
            <time dateTime={receipt.expiresAt}>
              {dateTime.format(new Date(receipt.expiresAt))} UTC
            </time>
          </p>
        </div>
        <a
          className="ui-button"
          download
          href={href}
          aria-label={`Download result manifest captured ${capturedAt} UTC`}
        >
          Download result manifest
        </a>
      </div>
      <ExportParts href={href} pages={receipt.pageCount} kind="trials" />
      <ExportParts href={href} pages={receipt.candidatePageCount} kind="configurations" />
    </li>
  );
}

export function BenchmarkComparisonExports({
  endpoint,
  initialReceipts,
  pagination,
}: {
  endpoint: string;
  initialReceipts: BenchmarkComparisonExportReceipt[];
  pagination?: ReactNode;
}) {
  const router = useRouter();
  const [created, setCreated] = useState<BenchmarkComparisonExportReceipt | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const requestId = useRef<string | null>(null);
  const action = useApiAction({
    call: async () => {
      const id = requestId.current ?? crypto.randomUUID();
      requestId.current = id;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requestId: id }),
      }).catch(() => {
        throw new Error("Connection interrupted. Retry to recover the export.");
      });
      if (response.status === 410) requestId.current = null;
      return response;
    },
    onSuccess: (payload) => {
      const parsed = benchmarkComparisonExportReceiptSchema.safeParse(payload);
      if (!parsed.success) throw new Error("Could not read the export receipt. Retry the export.");
      requestId.current = null;
      setCreated(parsed.data);
      router.refresh();
    },
    errorText: "Could not create the comparison export.",
    successText: "Result export ready to download.",
    setFlashMessage: setMessage,
  });
  const receipts = created
    ? [created, ...initialReceipts.filter(({ exportId }) => exportId !== created.exportId)]
    : initialReceipts;
  return (
    <PageSection
      anchorId="result-exports"
      title="Result exports"
      tagline="Capture every frozen trial, its provenance, and the totals at export time."
      actions={
        <button
          className="ui-button"
          disabled={action.isBusy}
          onClick={() => {
            setMessage(null);
            void action.run();
          }}
          type="button"
        >
          <ActionButtonLabel
            idle="Create result export"
            pending={action.isBusy}
            pendingLabel="Creating export…"
          />
        </button>
      }
    >
      <div className="ui-sheet divide-y divide-border">
        {message ? (
          <div className="px-4 py-3 sm:px-5">
            <InlineActionMessage message={message} />
          </div>
        ) : null}
        {receipts.length ? (
          <ul className="divide-y divide-border" aria-label="Result export history">
            {receipts.map((receipt) => (
              <ExportEntry key={receipt.exportId} endpoint={endpoint} receipt={receipt} />
            ))}
          </ul>
        ) : (
          <p className="type-secondary px-4 py-4 text-muted sm:px-5">No result exports yet.</p>
        )}
        {pagination}
      </div>
    </PageSection>
  );
}
