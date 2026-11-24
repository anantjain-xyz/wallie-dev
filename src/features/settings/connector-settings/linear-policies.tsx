"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { z } from "zod/v4";

import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  configureLinearDiscoverySchema,
  configureLinearOutboundSchema,
  linearDiscoveryConfigSchema,
  linearOutboundConfigSchema,
  linearPolicyRevisionSchema,
} from "@/lib/connectors/linear-policy-contracts";

import { connectorCommand, readConnectorResponse } from "./request";
import type { ConnectorResource } from "./resources";

type Discovery = z.output<typeof linearDiscoveryConfigSchema>;
type Outbound = z.output<typeof linearOutboundConfigSchema>;

export function LinearConnectorPolicies({
  factoryEndpoint,
  onChanged,
  resource,
}: {
  factoryEndpoint: string;
  onChanged: () => void;
  resource: ConnectorResource;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className="border-t border-border pt-4"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer text-sm font-semibold text-foreground">
        Linear routing and outcomes
      </summary>
      {open ? (
        <PolicyForms factoryEndpoint={factoryEndpoint} onChanged={onChanged} resource={resource} />
      ) : null}
    </details>
  );
}

function PolicyForms({
  factoryEndpoint,
  onChanged,
  resource,
}: {
  factoryEndpoint: string;
  onChanged: () => void;
  resource: ConnectorResource;
}) {
  const discoveryUrl = `${factoryEndpoint}/linear-discovery/${resource.id}`;
  const outboundUrl = `${factoryEndpoint}/linear-outbound/${resource.id}`;
  const [config, setConfig] = useState<{ discovery: Discovery; outbound: Outbound } | null>(null);
  const [loadError, setLoadError] = useState(false);

  useEffect(() => {
    const abort = new AbortController();
    const options = { signal: abort.signal };
    void Promise.all([
      fetch(discoveryUrl, options).then((response) =>
        readConnectorResponse(response, linearDiscoveryConfigSchema),
      ),
      fetch(outboundUrl, options).then((response) =>
        readConnectorResponse(response, linearOutboundConfigSchema),
      ),
    ])
      .then(([discovery, outbound]) => {
        if (!abort.signal.aborted) setConfig({ discovery, outbound });
      })
      .catch(() => {
        if (!abort.signal.aborted) setLoadError(true);
      });
    return () => abort.abort();
  }, [discoveryUrl, outboundUrl]);

  if (loadError)
    return (
      <p className="mt-3 text-sm text-danger" role="alert">
        Linear policy settings are unavailable. Reopen this panel to reload.
      </p>
    );
  if (!config)
    return (
      <p className="mt-3 text-sm text-muted" role="status">
        Loading Linear policies…
      </p>
    );

  return (
    <div className="mt-4 grid gap-4 md:grid-cols-2">
      <DiscoveryForm initial={config.discovery} onChanged={onChanged} url={discoveryUrl} />
      <OutboundForm
        initial={config.outbound}
        onChanged={onChanged}
        resource={resource}
        url={outboundUrl}
      />
    </div>
  );
}

function DiscoveryForm({
  initial,
  onChanged,
  url,
}: {
  initial: Discovery;
  onChanged: () => void;
  url: string;
}) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [stateIds, setStateIds] = useState(initial.stateIds.join(", "));
  const [labelId, setLabelId] = useState(initial.labelId ?? "");
  const [expectedRevision, setExpectedRevision] = useState(initial.revision);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const save = useApiAction<
    { revision: number },
    [z.output<typeof configureLinearDiscoverySchema>]
  >({
    call: (command) => fetch(url, connectorCommand(command, "PUT")),
    errorText: "Could not save Linear intake.",
    onSuccess: (payload) => {
      setExpectedRevision(linearPolicyRevisionSchema.parse(payload).revision);
      onChanged();
    },
    setFlashMessage: setMessage,
    successText: "Linear intake saved.",
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = configureLinearDiscoverySchema.safeParse({
      expectedRevision,
      mappingRevision: initial.mappingRevision,
      enabled,
      stateIds: stateIds.split(/[\s,]+/u).filter(Boolean),
      labelId: labelId.trim() || undefined,
      serviceActorId: initial.serviceActorId ?? undefined,
    });
    if (!command.success) {
      setMessage({
        kind: "error",
        text: "Enter 1–20 Linear workflow state IDs and a valid label ID if used.",
      });
      return;
    }
    setMessage(null);
    void save.run(command.data);
  }

  return (
    <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-foreground">Issue intake</h4>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
          type="checkbox"
        />
        Discover issues on this resource
      </label>
      <PolicyField label="Workflow state IDs" onChange={setStateIds} value={stateIds} />
      <p className="text-xs text-muted">Enter Linear workflow state UUIDs separated by commas.</p>
      <PolicyField label="Label ID (optional)" onChange={setLabelId} value={labelId} />
      <button
        className="ui-button-primary"
        disabled={save.isBusy || (!enabled && expectedRevision === 0)}
        type="submit"
      >
        {save.isBusy ? "Saving…" : "Save intake"}
      </button>
      <InlineActionMessage message={message} />
    </form>
  );
}

function OutboundForm({
  initial,
  onChanged,
  resource,
  url,
}: {
  initial: Outbound;
  onChanged: () => void;
  resource: ConnectorResource;
  url: string;
}) {
  const [commentsEnabled, setCommentsEnabled] = useState(initial.commentsEnabled);
  const [changeStatus, setChangeStatus] = useState(initial.statusMapping !== null);
  const [teamId, setTeamId] = useState(initial.statusMapping?.teamId ?? "");
  const [fromStateId, setFromStateId] = useState(initial.statusMapping?.fromStateId ?? "");
  const [toStateId, setToStateId] = useState(initial.statusMapping?.toStateId ?? "");
  const [expectedRevision, setExpectedRevision] = useState(initial.revision);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const save = useApiAction<{ revision: number }, [z.output<typeof configureLinearOutboundSchema>]>(
    {
      call: (command) => fetch(url, connectorCommand(command, "PUT")),
      errorText: "Could not save Linear outcomes.",
      onSuccess: (payload) => {
        setExpectedRevision(linearPolicyRevisionSchema.parse(payload).revision);
        onChanged();
      },
      setFlashMessage: setMessage,
      successText: "Linear outcomes saved.",
    },
  );

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const command = configureLinearOutboundSchema.safeParse({
      expectedRevision,
      mappingRevision: initial.mappingRevision,
      commentsEnabled,
      statusMapping: changeStatus
        ? {
            teamId: resource.kind === "team" ? resource.externalId : teamId.trim(),
            fromStateId: fromStateId.trim(),
            toStateId: toStateId.trim(),
          }
        : null,
    });
    if (!command.success) {
      setMessage({
        kind: "error",
        text: "Enter the Linear team ID and two different workflow state IDs.",
      });
      return;
    }
    setMessage(null);
    void save.run(command.data);
  }

  return (
    <form className="space-y-3 rounded-md border border-border p-3" onSubmit={submit}>
      <h4 className="text-sm font-semibold text-foreground">Linked outcomes</h4>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={commentsEnabled}
          onChange={(event) => setCommentsEnabled(event.target.checked)}
          type="checkbox"
        />
        Post updates to linked issues
      </label>
      <label className="flex items-center gap-2 text-sm text-foreground">
        <input
          checked={changeStatus}
          onChange={(event) => setChangeStatus(event.target.checked)}
          type="checkbox"
        />
        Change issue status after final approval
      </label>
      {changeStatus ? (
        <div className="space-y-3">
          {resource.kind === "project" ? (
            <PolicyField label="Linear team ID" onChange={setTeamId} value={teamId} />
          ) : null}
          <PolicyField label="From state ID" onChange={setFromStateId} value={fromStateId} />
          <PolicyField label="To state ID" onChange={setToStateId} value={toStateId} />
        </div>
      ) : null}
      <button className="ui-button-primary" disabled={save.isBusy} type="submit">
        {save.isBusy ? "Saving…" : "Save outcomes"}
      </button>
      <InlineActionMessage message={message} />
    </form>
  );
}

function PolicyField({
  label,
  onChange,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="block space-y-1.5 text-sm font-medium text-foreground">
      <span className="block">{label}</span>
      <input
        className="ui-input"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        value={value}
      />
    </label>
  );
}
