"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

import { FILTER_CONTROL_CLASS } from "@/components/ui/filter-controls";
import { SelectField } from "@/components/ui/select";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  connectorDeliveryPageSchema,
  type ConnectorDeliveryLane,
  type ConnectorDeliveryPage,
  type ConnectorDeliveryRow,
  type ConnectorRetryCommand,
} from "@/lib/connectors/diagnostics-contracts";
import { workspaceSessionDetailPath } from "@/lib/routes";

import { connectorCommand, readConnectorResponse } from "./request";

const kindLabel: Record<ConnectorDeliveryRow["kind"], string> = {
  github_admission: "GitHub work intake",
  github_comment: "GitHub comment intake",
  linear_intake: "Linear issue intake",
  slack_ingress: "Slack thread intake",
  outbound: "Outbound delivery",
};

const statusLabel: Partial<Record<ConnectorDeliveryRow["status"], string>> = {
  denied: "Rejected",
  unknown: "Outcome unknown",
};

const reasonLabel: Partial<Record<ConnectorDeliveryRow["reason"], string>> = {
  actor_not_allowed: "The provider actor is outside the allowed scope.",
  admission_denied: "The request did not satisfy the factory’s intake rules.",
  attempt_limit: "The delivery used its retry budget.",
  contention: "Workspace activity delayed comment processing.",
  credential_unavailable: "Provider access is unavailable.",
  expired: "The delivery’s retry window expired.",
  inconclusive: "The provider has not confirmed the prior result.",
  membership_denied: "The Slack bot can no longer read this channel.",
  not_sent: "The delivery was not sent.",
  processing_failed: "Comment processing failed.",
  rate_limited: "The provider asked Wallie to wait.",
  rejected: "The delivery was rejected.",
  retry_pending: "Processing is scheduled.",
  uncertain: "Wallie is checking whether the previous attempt reached the provider.",
};

const discoveryFailureLabel = {
  provider_unavailable: "Wallie could not reach or read from Linear.",
  provider_access_denied: "Linear denied access for the current credential.",
  invalid_provider_response: "Linear returned an invalid issue page.",
  scope_mismatch: "Linear returned data outside the configured scope.",
  discovery_commit_failed: "Wallie could not save the discovery result.",
};

function displayToken(value: string) {
  const words = value.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Timestamp({ value }: { value: string }) {
  return <time dateTime={value}>{new Date(value).toLocaleString()}</time>;
}

export function ConnectorDeliveryHistory({
  endpoint,
  workspaceSlug,
}: {
  endpoint: string;
  workspaceSlug: string;
}) {
  const [lane, setLane] = useState<ConnectorDeliveryLane>("all");

  return (
    <section className="space-y-3" aria-label="Delivery history">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h3 className="text-sm font-semibold text-foreground">Delivery history</h3>
        <SelectField
          align="end"
          className="w-36 max-w-full space-y-1"
          label="Direction"
          labelClassName="text-xs text-muted"
          onValueChange={(value) => {
            if (value === "ingress" || value === "outbound" || value === "all") setLane(value);
          }}
          options={[
            { label: "All deliveries", value: "all" },
            { label: "Ingress", value: "ingress" },
            { label: "Outbound", value: "outbound" },
          ]}
          triggerClassName={`gap-1.5 px-2.5 ${FILTER_CONTROL_CLASS}`}
          value={lane}
        />
      </div>
      <DeliveryPage endpoint={endpoint} key={lane} lane={lane} workspaceSlug={workspaceSlug} />
    </section>
  );
}

function DeliveryPage({
  endpoint,
  lane,
  workspaceSlug,
}: {
  endpoint: string;
  lane: ConnectorDeliveryLane;
  workspaceSlug: string;
}) {
  const [data, setData] = useState<ConnectorDeliveryPage | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const url = `${endpoint}/deliveries?lane=${lane}`;

  useEffect(() => {
    const abort = new AbortController();
    void fetch(url, { signal: abort.signal })
      .then((response) => readConnectorResponse(response, connectorDeliveryPageSchema))
      .then((page) => {
        if (abort.signal.aborted) return;
        setData(page);
        setLoadError(false);
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true);
      });
    return () => abort.abort();
  }, [reload, url]);

  const loadMore = useApiAction<ConnectorDeliveryPage, [string]>({
    call: (cursor) => fetch(`${url}&cursor=${encodeURIComponent(cursor)}`),
    errorText: "Could not load more deliveries.",
    onSuccess: (payload) => {
      const next = connectorDeliveryPageSchema.parse(payload);
      setData((current) =>
        current
          ? {
              ...next,
              deliveries: [...current.deliveries, ...next.deliveries],
            }
          : next,
      );
    },
    setFlashMessage: setMessage,
  });

  const retry = useApiAction<{ scheduled: true }, [ConnectorRetryCommand]>({
    call: async (command) => {
      const response = await fetch(`${endpoint}/deliveries/retry`, connectorCommand(command));
      if (response.status === 409) {
        refresh();
        throw new Error("This delivery changed. Review its current status before trying again.");
      }
      return response;
    },
    errorText: "Could not schedule this delivery.",
    onSuccess: async () => {
      setData(null);
      setReload((value) => value + 1);
    },
    setFlashMessage: setMessage,
    successText: (_payload, [command]) =>
      command.mode === "observe"
        ? "Provider status check scheduled."
        : "Retry scheduled for this delivery.",
  });

  function refresh() {
    setLoadError(false);
    setData(null);
    setMessage(null);
    setReload((value) => value + 1);
  }

  async function schedule(row: ConnectorDeliveryRow) {
    if (!row.canRetry || (row.kind !== "github_comment" && row.kind !== "outbound")) return;
    const command: ConnectorRetryCommand =
      row.kind === "github_comment"
        ? { kind: row.kind, id: row.id, mode: "retry" }
        : { kind: row.kind, id: row.id, mode: row.uncertain ? "observe" : "retry" };
    setMessage(null);
    setRetrying(row.id);
    await retry.run(command);
    setRetrying(null);
  }

  const discovery = data?.linearDiscovery;
  return (
    <div className="space-y-3">
      {discovery ? <LinearDiscoveryHealth discovery={discovery} /> : null}
      {loadError ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2">
          <p role="alert" className="text-sm text-danger">
            Delivery history is unavailable.
          </p>
          <button className="ui-button" onClick={refresh} type="button">
            Reload history
          </button>
        </div>
      ) : !data ? (
        <p className="text-sm text-muted" role="status">
          Loading delivery history…
        </p>
      ) : data.deliveries.length ? (
        <ul className="divide-y divide-border rounded-md border border-border">
          {data.deliveries.map((row) => (
            <DeliveryRow
              key={`${row.kind}:${row.id}`}
              onRetry={() => void schedule(row)}
              retryDisabled={retry.isBusy || loadMore.isBusy}
              retrying={retry.isBusy && retrying === row.id}
              row={row}
              workspaceSlug={workspaceSlug}
            />
          ))}
        </ul>
      ) : (
        <p className="rounded-md border border-border px-3 py-4 text-sm text-muted">
          No deliveries for this resource.
        </p>
      )}
      {data ? (
        <div className="flex flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={retry.isBusy || loadMore.isBusy}
            onClick={refresh}
            type="button"
          >
            Refresh history
          </button>
          {data.nextCursor ? (
            <button
              className="ui-button"
              disabled={retry.isBusy || loadMore.isBusy}
              onClick={() => {
                if (!data.nextCursor) return;
                setMessage(null);
                void loadMore.run(data.nextCursor);
              }}
              type="button"
            >
              {loadMore.isBusy ? "Loading…" : "Load older deliveries"}
            </button>
          ) : null}
        </div>
      ) : null}
      <InlineActionMessage message={message} />
    </div>
  );
}

function LinearDiscoveryHealth({
  discovery,
}: {
  discovery: NonNullable<ConnectorDeliveryPage["linearDiscovery"]>;
}) {
  const { status, lastFailureAt, lastFailureReason, nextScanAt, retryAt } = discovery;
  return (
    <div className="space-y-1 rounded-md border border-border px-3 py-2 text-sm text-muted">
      <p>
        <strong className="font-medium text-foreground">Linear discovery</strong>
        {" · "}
        {status === "failed" ? "Last scan failed" : displayToken(status)}
        {retryAt ? (
          <>
            {" "}
            · Provider cooldown until <Timestamp value={retryAt} />
          </>
        ) : (status === "scheduled" || status === "failed") && nextScanAt ? (
          <>
            {" "}
            · Next scan <Timestamp value={nextScanAt} />
          </>
        ) : null}
      </p>
      {lastFailureAt && lastFailureReason ? (
        <p>
          {discoveryFailureLabel[lastFailureReason]} <Timestamp value={lastFailureAt} />
        </p>
      ) : null}
    </div>
  );
}

function DeliveryRow({
  onRetry,
  retryDisabled,
  retrying,
  row,
  workspaceSlug,
}: {
  onRetry: () => void;
  retryDisabled: boolean;
  retrying: boolean;
  row: ConnectorDeliveryRow;
  workspaceSlug: string;
}) {
  const title = [
    kindLabel[row.kind],
    row.sourceReference ?? (row.operation ? displayToken(row.operation) : null),
  ]
    .filter(Boolean)
    .join(" · ");
  const isFailure = row.status === "failed" || row.status === "denied";
  return (
    <li className="flex flex-wrap items-start justify-between gap-3 px-3 py-3">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <span
            className={`rounded border px-1.5 py-0.5 text-xs ${isFailure ? "border-danger/20 bg-danger-soft text-danger" : "border-border text-muted"}`}
          >
            {statusLabel[row.status] ?? displayToken(row.status)}
          </span>
        </div>
        {row.reason !== row.status ? (
          <p className="text-sm text-muted">
            {reasonLabel[row.reason] ?? displayToken(row.reason)}
          </p>
        ) : null}
        {row.uncertain && row.reason !== "uncertain" ? (
          <p className="text-sm text-muted">Wallie checks the provider before any further send.</p>
        ) : null}
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
          <span>
            Recorded <Timestamp value={row.recordedAt} />
          </span>
          {row.nextAttemptAt ? (
            <span>
              Next attempt <Timestamp value={row.nextAttemptAt} />
            </span>
          ) : null}
          {row.attempts ? <span>Attempts {row.attempts}</span> : null}
          {row.observationAttempts ? <span>Provider checks {row.observationAttempts}</span> : null}
        </p>
        {row.sessionNumber ? (
          <Link
            className="text-xs font-medium text-accent hover:underline"
            href={workspaceSessionDetailPath(workspaceSlug, row.sessionNumber)}
          >
            View session #{row.sessionNumber}
          </Link>
        ) : null}
      </div>
      {row.canRetry ? (
        <button className="ui-button" disabled={retryDisabled} onClick={onRetry} type="button">
          {retrying ? "Scheduling…" : row.uncertain ? "Check provider status" : "Schedule retry"}
        </button>
      ) : null}
    </li>
  );
}
