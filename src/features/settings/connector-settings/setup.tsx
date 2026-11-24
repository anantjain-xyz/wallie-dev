"use client";

import { useState } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  connectorCatalogResponseSchema,
  connectorSetupResponseSchema,
  type ConnectorCatalogResponse,
  type ConnectorSetupCommand,
  type ConnectorSetupResponse,
} from "@/lib/connectors/setup-contracts";

import { connectorCommand } from "./request";
import type { ConnectorInstallation, ConnectorProvider, ConnectorResource } from "./resources";
import { ConnectorSelect } from "./select";

type ResourceKind = ConnectorResource["kind"];

const setupMessage: Record<ConnectorSetupCommand["action"], string> = {
  connect: "Connector connected.",
  map: "Resource mapped to this factory.",
  disable: "Resource mapping disabled.",
  disconnect: "Connector disconnected.",
  github_request: "GitHub intake label saved.",
};

function useConnectorSetup(
  endpoint: string,
  setMessage: (message: FlashMessage) => void,
  onChanged: (resourceId?: string) => void,
) {
  return useApiAction<ConnectorSetupResponse, [ConnectorSetupCommand], true>({
    call: (command) => fetch(`${endpoint}/setup`, connectorCommand(command)),
    errorText: "Could not update connector setup.",
    onSuccess: (payload, [command]) => {
      const result = connectorSetupResponseSchema.parse(payload);
      onChanged(command.action === "map" && "resourceId" in result ? result.resourceId : undefined);
      return true;
    },
    setFlashMessage: setMessage,
    successText: (_payload, [command]) => setupMessage[command.action],
  });
}

function useCatalog(endpoint: string, query: string, setMessage: (message: FlashMessage) => void) {
  const [catalog, setCatalog] = useState<ConnectorCatalogResponse | null>(null);
  const [selected, setSelected] = useState("");
  const action = useApiAction<ConnectorCatalogResponse, [string?]>({
    call: (cursor) => {
      const search = new URLSearchParams(query);
      if (cursor) search.set("cursor", cursor);
      return fetch(`${endpoint}/catalog?${search}`);
    },
    errorText: "Could not verify provider access.",
    onSuccess: (payload, [cursor]) => {
      const data = connectorCatalogResponseSchema.parse(payload);
      setCatalog((prior) => {
        if (!prior || !cursor || prior.tenant.id !== data.tenant.id) return data;
        const known = new Set(prior.resources.map(({ id }) => id));
        return {
          ...data,
          resources: [...prior.resources, ...data.resources.filter(({ id }) => !known.has(id))],
        };
      });
      if (!cursor) setSelected("");
    },
    setFlashMessage: setMessage,
  });

  return {
    catalog,
    selected,
    setSelected,
    option: catalog?.resources.find(({ id }) => id === selected),
    load: action.run,
    busy: action.isBusy,
  };
}

function CatalogChoices({
  busy,
  catalog,
  disabled,
  label,
  loadOlder,
  onSelect,
  selected,
}: {
  busy: boolean;
  catalog: ConnectorCatalogResponse;
  disabled: boolean;
  label: string;
  loadOlder: (cursor: string) => void;
  onSelect: (id: string) => void;
  selected: string;
}) {
  return (
    <div className="space-y-2">
      {catalog.resources.length ? (
        <ConnectorSelect
          className="block max-w-xl space-y-1.5 text-sm font-medium text-foreground"
          label={label}
          disabled={disabled}
          onChange={(event) => onSelect(event.target.value)}
          value={selected}
        >
          <option value="">Choose an option</option>
          {catalog.resources.map(({ id, label }) => (
            <option key={id} value={id}>
              {label}
            </option>
          ))}
        </ConnectorSelect>
      ) : (
        <p className="text-sm text-muted">No available options were returned.</p>
      )}
      {catalog.nextCursor ? (
        <button
          className="ui-button"
          disabled={disabled || busy}
          onClick={() => {
            if (catalog.nextCursor) loadOlder(catalog.nextCursor);
          }}
          type="button"
        >
          {busy ? "Loading…" : "Load more options"}
        </button>
      ) : null}
    </div>
  );
}

export function ConnectorSetup({
  disabled,
  endpoint,
  installation,
  installations,
  onChanged,
  provider,
  resource,
  resources,
}: {
  disabled: boolean;
  endpoint: string;
  installation?: ConnectorInstallation;
  installations: ConnectorInstallation[];
  onChanged: (resourceId?: string) => void;
  provider: ConnectorProvider;
  resource?: ConnectorResource;
  resources: ConnectorResource[];
}) {
  const [kind, setKind] = useState<ResourceKind>(provider === "github" ? "repository" : "team");
  const [confirm, setConfirm] = useState<"disconnect" | "disable" | null>(null);
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const action = useConnectorSetup(endpoint, setMessage, onChanged);
  const inactive = disabled || action.isBusy;

  async function confirmChange() {
    if (!installation) return;
    setMessage(null);
    const command =
      confirm === "disconnect"
        ? {
            action: "disconnect" as const,
            installationId: installation.id,
            expectedGeneration: installation.generation,
          }
        : resource
          ? {
              action: "disable" as const,
              resourceId: resource.id,
              expectedGeneration: installation.generation,
              expectedMappingRevision: resource.mappingRevision,
            }
          : null;
    if (command && (await action.run(command))) setConfirm(null);
  }

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">Connector setup</h3>
      <p className="text-sm text-muted">
        {provider === "github" ? (
          <>
            Set up the{" "}
            <a className="font-medium text-accent hover:underline" href="#github">
              GitHub App
            </a>{" "}
            to find repositories assigned to this factory.
          </>
        ) : (
          <>
            Save a key in{" "}
            <a className="font-medium text-accent hover:underline" href="#linear">
              Linear settings
            </a>{" "}
            to find teams and projects.
          </>
        )}
      </p>
      {provider === "linear" ? (
        <ConnectorSelect
          label="Resource type"
          disabled={inactive}
          onChange={(event) => setKind(event.target.value === "project" ? "project" : "team")}
          value={kind}
        >
          <option value="team">Team</option>
          <option value="project">Project</option>
        </ConnectorSelect>
      ) : null}
      <MapResource
        disabled={inactive}
        endpoint={endpoint}
        installations={installations}
        key={kind}
        kind={kind}
        provider={provider}
        resources={resources}
        run={action.run}
        setMessage={setMessage}
      />
      {installation && (resource?.enabled || installation.status !== "disconnected") ? (
        <div className="flex flex-wrap gap-2">
          {resource?.enabled ? (
            <button
              className="ui-button"
              disabled={inactive}
              onClick={() => {
                setMessage(null);
                setConfirm("disable");
              }}
              type="button"
            >
              Disable mapping
            </button>
          ) : null}
          {installation.status !== "disconnected" ? (
            <button
              className="ui-button"
              disabled={inactive}
              onClick={() => {
                setMessage(null);
                setConfirm("disconnect");
              }}
              type="button"
            >
              Disconnect connector
            </button>
          ) : null}
        </div>
      ) : null}
      <DestructiveConfirmationDialog
        actionLabel={confirm === "disconnect" ? "Disconnect connector" : "Disable mapping"}
        description={
          confirm === "disconnect"
            ? "This disconnects the provider installation for every factory that uses it in this workspace. Delivery history stays available."
            : "Wallie will stop accepting new work or sending replies through this resource mapping. Delivery history stays available."
        }
        errorMessage={message?.kind === "error" ? message.text : null}
        onConfirm={() => void confirmChange()}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        open={confirm !== null}
        pending={action.isBusy}
        pendingLabel="Saving…"
        title={
          confirm === "disconnect" ? "Disconnect this connector?" : "Disable this resource mapping?"
        }
      />
      {confirm === null ? <InlineActionMessage message={message} /> : null}
    </div>
  );
}

function MapResource({
  disabled,
  endpoint,
  installations,
  kind,
  provider,
  resources,
  run,
  setMessage,
}: {
  disabled: boolean;
  endpoint: string;
  installations: ConnectorInstallation[];
  kind: ResourceKind;
  provider: ConnectorProvider;
  resources: ConnectorResource[];
  run: (command: ConnectorSetupCommand) => Promise<true | undefined>;
  setMessage: (message: FlashMessage | null) => void;
}) {
  const { catalog, selected, setSelected, option, load, busy } = useCatalog(
    endpoint,
    new URLSearchParams({ provider, kind }).toString(),
    setMessage,
  );
  const authority = installations.find(
    ({ externalTenantId }) => externalTenantId === catalog?.tenant.id,
  );
  const mapping =
    option &&
    resources.find(
      (item) =>
        item.kind === kind &&
        item.externalId === (option.externalId ?? option.id) &&
        item.installationId === authority?.id,
    );

  function getOptions(cursor?: string) {
    setMessage(null);
    void load(cursor);
  }

  function connect() {
    if (!catalog) return;
    setMessage(null);
    void run({
      action: "connect",
      provider,
      expectedGeneration: authority?.generation ?? 0,
      expectedTenantId: catalog.tenant.id,
    });
  }

  function map() {
    if (!option || !authority) return;
    setMessage(null);
    void run({
      action: "map",
      installationId: authority.id,
      expectedGeneration: authority.generation,
      expectedMappingRevision: mapping?.mappingRevision ?? 0,
      resource: { kind, id: option.id },
    });
  }

  return (
    <div className="space-y-3">
      <button
        className="ui-button"
        disabled={disabled || busy}
        onClick={() => getOptions()}
        type="button"
      >
        {busy && !catalog ? "Checking access…" : "Find provider resources"}
      </button>
      {catalog ? (
        <div className="space-y-3 rounded-md border border-border p-3">
          <p className="text-sm text-muted">
            Verified <strong className="font-medium text-foreground">{catalog.tenant.label}</strong>
          </p>
          {authority?.status !== "connected" ? (
            <button
              className="ui-button-primary"
              disabled={disabled || busy}
              onClick={connect}
              type="button"
            >
              {authority ? "Reconnect connector" : "Connect provider"}
            </button>
          ) : (
            <>
              <CatalogChoices
                busy={busy}
                catalog={catalog}
                disabled={disabled}
                label="Resource to map"
                loadOlder={getOptions}
                onSelect={setSelected}
                selected={selected}
              />
              <button
                className="ui-button-primary"
                disabled={disabled || busy || !option || Boolean(mapping?.enabled)}
                onClick={map}
                type="button"
              >
                {mapping?.enabled
                  ? "Already mapped"
                  : mapping
                    ? "Enable mapping"
                    : "Map to factory"}
              </button>
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function GitHubRequestRule({
  disabled,
  endpoint,
  onChanged,
  resource,
}: {
  disabled: boolean;
  endpoint: string;
  onChanged: () => void;
  resource: ConnectorResource;
}) {
  const [sourceKind, setSourceKind] = useState<"issue" | "pull_request">("issue");
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const { catalog, selected, option, setSelected, load, busy } = useCatalog(
    endpoint,
    new URLSearchParams({ provider: "github", kind: "label", resourceId: resource.id }).toString(),
    setMessage,
  );
  const action = useConnectorSetup(endpoint, setMessage, onChanged);
  const current = resource.githubRequests.find((rule) => rule.sourceKind === sourceKind);
  const inactive = disabled || action.isBusy;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <h3 className="text-sm font-semibold text-foreground">GitHub work intake</h3>
      <ConnectorSelect
        label="Request source"
        disabled={inactive}
        onChange={(event) => {
          setSourceKind(event.target.value === "pull_request" ? "pull_request" : "issue");
          setMessage(null);
        }}
        value={sourceKind}
      >
        <option value="issue">Issue</option>
        <option value="pull_request">Pull request</option>
      </ConnectorSelect>
      <p className="text-sm text-muted">
        {current?.enabled
          ? `Intake enabled for label ID ${current.labelId}.`
          : "Intake is disabled for this request source."}
      </p>
      <button
        className="ui-button"
        disabled={inactive || busy}
        onClick={() => {
          setMessage(null);
          void load();
        }}
        type="button"
      >
        {busy && !catalog ? "Loading labels…" : "Find repository labels"}
      </button>
      {catalog ? (
        <div className="space-y-3">
          <CatalogChoices
            busy={busy}
            catalog={catalog}
            disabled={inactive}
            label="Intake label"
            loadOlder={(cursor) => void load(cursor)}
            onSelect={setSelected}
            selected={selected}
          />
          <button
            className="ui-button-primary"
            disabled={inactive || busy || !option}
            onClick={() => {
              if (!option) return;
              setMessage(null);
              void action.run({
                action: "github_request",
                resourceId: resource.id,
                sourceKind,
                expectedRevision: current?.revision ?? 0,
                labelId: Number(option.id),
                labelName: option.label,
              });
            }}
            type="button"
          >
            Save intake label
          </button>
        </div>
      ) : null}
      <InlineActionMessage message={message} />
    </div>
  );
}
