"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { PageSection } from "@/components/ui/page-shell";
import { SelectField } from "@/components/ui/select";
import { GovernanceTime } from "@/features/factory-governance/governance-resource-link";
import { type FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import type {
  loadFactoryEventDeliveries,
  loadFactoryEventSubscriptionSettings,
} from "@/lib/factory-event-subscriptions/management";
import {
  createFactoryEventSubscriptionSchema,
  factoryOutboundEventLabels,
  type FactoryEventSubscriptionCommand,
} from "@/lib/factory-event-subscriptions/management-contracts";

type SubscriptionSettings = Awaited<ReturnType<typeof loadFactoryEventSubscriptionSettings>>;
type Subscription = SubscriptionSettings["subscriptions"][number];
type DeliveryPage = Awaited<ReturnType<typeof loadFactoryEventDeliveries>>;

const deliveryLabels = {
  queued: "Queued",
  claimed: "Preparing",
  sending: "Sending",
  delivered: "Delivered",
  failed: "Failed",
  unknown: "Delivery unconfirmed",
  revoked: "Authority revoked",
};

function post(endpoint: string, command: FactoryEventSubscriptionCommand) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function GovernanceEventSubscriptions({
  data,
  endpoint,
}: {
  data: SubscriptionSettings | null;
  endpoint: string;
}) {
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <PageSection anchorId="event-subscriptions" title="Event subscriptions">
      {!data ? (
        <p className="type-secondary text-muted">
          Event subscriptions are temporarily unavailable.
        </p>
      ) : (
        <div className="space-y-4">
          <EventSubscriptionForm
            key={endpoint}
            authorizations={data.authorizations}
            endpoint={endpoint}
          />
          {data.subscriptions.length ? (
            <ul className="ui-sheet divide-y divide-border">
              {data.subscriptions.map((subscription) => (
                <SubscriptionRow
                  endpoint={endpoint}
                  expanded={selected === subscription.id}
                  onToggle={() =>
                    setSelected((id) => (id === subscription.id ? null : subscription.id))
                  }
                  key={subscription.id}
                  subscription={subscription}
                />
              ))}
            </ul>
          ) : (
            <p className="type-secondary text-muted">No event subscriptions for this factory.</p>
          )}
        </div>
      )}
    </PageSection>
  );
}

function EventSubscriptionForm({
  authorizations,
  endpoint,
}: {
  authorizations: SubscriptionSettings["authorizations"];
  endpoint: string;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const name = useRef<HTMLInputElement>(null);
  const copyButton = useRef<HTMLButtonElement>(null);
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [signingSecret, setSigningSecret] = useState<string | null>(null);
  const action = useApiAction<{ signingSecret: string }, [FactoryEventSubscriptionCommand]>({
    call: (command) => post(endpoint, command),
    errorText: "Could not create the subscription.",
    successText:
      "Subscription created. Configure your receiver and verify ownership to start delivery.",
    onSuccess: ({ signingSecret }) => {
      setSigningSecret(signingSecret);
      form.current?.reset();
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  useEffect(() => {
    if (signingSecret) copyButton.current?.focus();
  }, [signingSecret]);

  async function copySecret() {
    if (!signingSecret) return;
    try {
      await navigator.clipboard.writeText(signingSecret);
      setFeedback({ kind: "success", text: "Signing secret copied." });
    } catch {
      setFeedback({ kind: "error", text: "Select and copy the signing secret manually." });
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const authorization = authorizations.find(
      (choice) => `${choice.credential_kind}:${choice.credential_id}` === fields.get("authority"),
    );
    const command = createFactoryEventSubscriptionSchema.safeParse({
      action: "create",
      name: fields.get("name"),
      destination: fields.get("destination"),
      credentialKind: authorization?.credential_kind,
      credentialId: authorization?.credential_id,
      eventTypes: fields.getAll("eventType"),
    });
    if (!command.success) {
      setFeedback({
        kind: "error",
        text: "Enter a name and endpoint, and choose an authorization and event.",
      });
      return;
    }
    setFeedback(null);
    void action.run(command.data);
  }

  return (
    <div className="space-y-3">
      {signingSecret ? (
        <div aria-label="Signing secret" className="ui-sheet space-y-3 p-4 sm:p-5" role="region">
          <p className="type-label text-foreground">Signing secret</p>
          <p className="type-secondary text-muted">
            Save this secret in your receiver. Wallie shows it once.
          </p>
          <code className="block text-sm text-foreground select-all [overflow-wrap:anywhere]">
            {signingSecret}
          </code>
          <div className="flex flex-wrap gap-2">
            <button
              className="ui-button ui-button-primary"
              onClick={() => void copySecret()}
              ref={copyButton}
              type="button"
            >
              Copy secret
            </button>
            <button
              className="ui-button"
              onClick={() => {
                setSigningSecret(null);
                setFeedback(null);
                requestAnimationFrame(() => name.current?.focus());
              }}
              type="button"
            >
              Dismiss secret
            </button>
          </div>
        </div>
      ) : null}
      <InlineActionMessage message={feedback} />
      {authorizations.length ? (
        <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit} ref={form}>
          <fieldset className="space-y-4" disabled={action.isBusy || Boolean(signingSecret)}>
            <legend className="type-label mb-2 text-foreground">Add an event subscription</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block min-w-0 space-y-1.5">
                <span className="type-label text-foreground">Name</span>
                <input className="ui-input" maxLength={120} name="name" ref={name} required />
              </label>
              <label className="block min-w-0 space-y-1.5">
                <span className="type-label text-foreground">HTTPS endpoint</span>
                <input
                  className="ui-input"
                  maxLength={2048}
                  name="destination"
                  required
                  type="url"
                />
              </label>
            </div>
            <SelectField
              defaultValue=""
              emptyOption={{ disabled: true, label: "Choose an authorization", value: "" }}
              label="Authorization"
              labelClassName="type-label text-foreground"
              name="authority"
              options={authorizations.map((authorization) => {
                const value = `${authorization.credential_kind}:${authorization.credential_id}`;
                const kind =
                  authorization.credential_kind === "machine_token"
                    ? "Machine token"
                    : "OAuth client";
                return {
                  label: `${authorization.credential_name} · ${kind} · ${authorization.credential_id.slice(0, 8)}`,
                  value,
                };
              })}
              required
              wrap
            />
            <fieldset className="grid min-w-0 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              <legend className="type-label mb-2 text-foreground">Events</legend>
              {Object.entries(factoryOutboundEventLabels).map(([value, label]) => (
                <label className="flex items-start gap-2 text-sm text-foreground" key={value}>
                  <input className="mt-0.5" name="eventType" type="checkbox" value={value} />
                  {label}
                </label>
              ))}
            </fieldset>
            <button className="ui-button ui-button-primary" type="submit">
              <ActionButtonLabel
                idle="Create subscription"
                pending={action.isBusy}
                pendingLabel="Creating…"
              />
            </button>
          </fieldset>
        </form>
      ) : (
        <p className="type-secondary text-muted">
          A machine token or OAuth authorization with session read access is required.
        </p>
      )}
    </div>
  );
}

function SubscriptionRow({
  endpoint,
  expanded,
  onToggle,
  subscription,
}: {
  endpoint: string;
  expanded: boolean;
  onToggle: () => void;
  subscription: Subscription;
}) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const action = useApiAction<unknown, [FactoryEventSubscriptionCommand]>({
    call: (command) => post(endpoint, command),
    errorText: "Could not update the subscription.",
    successText: (_payload, [command]) =>
      command.action === "verify" ? "Endpoint verified." : "Subscription revoked.",
    onSuccess: () => {
      setConfirm(false);
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });
  const { authorized, endpoint_url, event_types, id, name, status } = subscription;
  const statusLabel =
    status === "revoked"
      ? "Revoked"
      : !authorized
        ? "Authorization unavailable"
        : status === "pending"
          ? "Awaiting verification"
          : "Active";

  return (
    <li className="space-y-3 p-4 sm:p-5">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground [overflow-wrap:anywhere]">{name}</h3>
        <p className="type-secondary text-muted [overflow-wrap:anywhere]">{endpoint_url}</p>
        <p className="type-secondary text-muted">
          {statusLabel} · {event_types.map((event) => factoryOutboundEventLabels[event]).join(", ")}
        </p>
      </div>
      <InlineActionMessage message={confirm ? null : feedback} />
      {status === "pending" && authorized ? (
        <p className="type-secondary text-muted">
          Configure the endpoint to echo the verification challenge in its{" "}
          <code>Wallie-Verification</code> response header.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button className="ui-button" aria-expanded={expanded} onClick={onToggle} type="button">
          {expanded ? "Hide deliveries" : "Inspect deliveries"}
          <span className="sr-only"> for {name}</span>
        </button>
        {status === "pending" && authorized ? (
          <button
            className="ui-button"
            disabled={action.isBusy}
            onClick={() => void action.run({ action: "verify", subscriptionId: id })}
            type="button"
          >
            <ActionButtonLabel
              idle="Verify endpoint"
              pending={action.isBusy && !confirm}
              pendingLabel="Verifying…"
            />
          </button>
        ) : null}
        {status !== "revoked" ? (
          <DestructiveConfirmationDialog
            actionLabel="Revoke subscription"
            description="Wallie will stop sending events to this subscription."
            errorMessage={confirm && feedback?.kind === "error" ? feedback.text : null}
            onConfirm={() => void action.run({ action: "revoke", subscriptionId: id })}
            onOpenChange={(open) => {
              setFeedback(null);
              setConfirm(open);
            }}
            open={confirm}
            pending={confirm && action.isBusy}
            pendingLabel="Revoking…"
            title={`Revoke ${name}?`}
            trigger={
              <button className="ui-button-danger" disabled={action.isBusy} type="button">
                Revoke subscription
              </button>
            }
          />
        ) : null}
      </div>
      {expanded ? (
        <DeliveryHistory
          canRetry={status === "active" && authorized}
          endpoint={endpoint}
          subscriptionId={id}
        />
      ) : null}
    </li>
  );
}

function DeliveryHistory({
  canRetry,
  endpoint,
  subscriptionId,
}: {
  canRetry: boolean;
  endpoint: string;
  subscriptionId: string;
}) {
  const [page, setPage] = useState<DeliveryPage | null>(null);
  const [cursor, setCursor] = useState<string>();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);

  const getDeliveries = useCallback(
    (cursor?: string) => {
      const query = new URLSearchParams({ subscriptionId });
      if (cursor) query.set("cursor", cursor);
      return fetch(`${endpoint}?${query}`, { cache: "no-store" });
    },
    [endpoint, subscriptionId],
  );
  const showPage = useCallback((result: DeliveryPage, [cursor]: [string?]) => {
    setPage(result);
    setCursor(cursor);
  }, []);
  const clearPage = useCallback(() => setPage(null), []);

  const read = useApiAction<DeliveryPage, [string?]>({
    call: getDeliveries,
    errorText: "Could not read delivery history.",
    onSuccess: showPage,
    onError: clearPage,
    setFlashMessage: setFeedback,
  });
  const loadDeliveryPage = read.run;
  useEffect(() => {
    void loadDeliveryPage();
  }, [loadDeliveryPage]);
  const retry = useApiAction<unknown, [string]>({
    call: (deliveryId) => post(endpoint, { action: "retry", deliveryId }),
    errorText: "Could not retry delivery.",
    onSuccess: async () => {
      await read.run(cursor);
    },
    successText: "Delivery queued.",
    setFlashMessage: setFeedback,
  });

  return (
    <section aria-label="Delivery history" className="space-y-3 border-t border-border pt-3">
      <InlineActionMessage message={feedback} />
      <div className="flex flex-wrap gap-2">
        <button
          className="ui-button"
          disabled={read.isBusy || retry.isBusy}
          onClick={() => {
            setFeedback(null);
            void read.run(cursor);
          }}
          type="button"
        >
          <ActionButtonLabel
            idle={page ? "Refresh deliveries" : "Load deliveries"}
            pending={read.isBusy}
            pendingLabel="Loading…"
          />
        </button>
        {cursor ? (
          <button
            className="ui-button"
            disabled={read.isBusy || retry.isBusy}
            onClick={() => void read.run()}
            type="button"
          >
            Newest deliveries
          </button>
        ) : null}
        {page?.nextCursor ? (
          <button
            className="ui-button"
            disabled={read.isBusy || retry.isBusy}
            onClick={() => void read.run(page.nextCursor ?? undefined)}
            type="button"
          >
            Older deliveries
          </button>
        ) : null}
      </div>
      {page && page.deliveries.length === 0 ? (
        <p className="type-secondary text-muted">No deliveries on this page.</p>
      ) : null}
      {page?.deliveries.length ? (
        <ul className="divide-y divide-border">
          {page.deliveries.map((delivery) => (
            <li className="flex flex-wrap items-start justify-between gap-3 py-3" key={delivery.id}>
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium text-foreground">
                  {factoryOutboundEventLabels[delivery.event_type]} ·{" "}
                  {deliveryLabels[delivery.status]}
                </p>
                <p className="type-secondary text-muted">
                  {delivery.attempt_count} {delivery.attempt_count === 1 ? "attempt" : "attempts"}
                  {delivery.last_http_status ? ` · HTTP ${delivery.last_http_status}` : ""}
                  {" · "}
                  <GovernanceTime value={delivery.created_at} />
                </p>
                <p className="type-secondary text-muted [overflow-wrap:anywhere]">
                  Event <code>{delivery.event_id}</code>
                </p>
                {delivery.has_unknown_outcome && delivery.status !== "unknown" ? (
                  <p className="type-secondary text-muted">Earlier attempt unconfirmed.</p>
                ) : null}
                {delivery.next_attempt_at ? (
                  <p className="type-secondary text-muted">
                    Next attempt <GovernanceTime value={delivery.next_attempt_at} />
                  </p>
                ) : null}
              </div>
              {canRetry && delivery.retryable ? (
                <button
                  className="ui-button"
                  disabled={retry.isBusy || read.isBusy}
                  onClick={() => {
                    setFeedback(null);
                    void retry.run(delivery.id);
                  }}
                  type="button"
                >
                  Retry delivery<span className="sr-only"> for {delivery.event_id}</span>
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
