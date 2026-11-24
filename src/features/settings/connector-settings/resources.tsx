"use client";

import { useEffect, useState } from "react";

import {
  connectorInventorySchema,
  type ConnectorInventory,
} from "@/lib/connectors/diagnostics-contracts";

import { ConnectorDeliveryHistory } from "./history";
import { LinearConnectorPolicies } from "./linear-policies";
import { readConnectorResponse } from "./request";
import { ConnectorSelect } from "./select";
import { ConnectorSetup, GitHubRequestRule } from "./setup";

export type ConnectorInstallation = ConnectorInventory["installations"][number];
export type ConnectorResource = ConnectorInventory["resources"][number];
export type ConnectorProvider = ConnectorResource["provider"];

const providerLabel = { github: "GitHub", linear: "Linear" };
const kindLabel = { repository: "Repository", team: "Team", project: "Project" };

export const connectionStatusLabel: Record<ConnectorResource["connectionStatus"], string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  credential_unavailable: "Access unavailable",
};

export function resourceLabel(resource: ConnectorResource) {
  if (resource.label) return resource.label;
  const identity =
    resource.provider === "linear" ? resource.externalId.slice(-12) : resource.externalId;
  return `${kindLabel[resource.kind]} · ${identity}`;
}

export function ConnectorResources({
  factoryId,
  workspaceId,
  workspaceSlug,
}: {
  factoryId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const [provider, setProvider] = useState<ConnectorProvider>("github");
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const factoryEndpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}`;
  const endpoint = `${factoryEndpoint}/connectors`;

  useEffect(() => {
    const abort = new AbortController();
    void fetch(endpoint, { signal: abort.signal })
      .then((response) => readConnectorResponse(response, connectorInventorySchema))
      .then((data) => {
        if (abort.signal.aborted) return;
        setInventory(data);
        setError(false);
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setInventory(null);
        setError(true);
      })
      .finally(() => {
        if (!abort.signal.aborted) setRefreshing(false);
      });
    return () => abort.abort();
  }, [endpoint, reload]);

  function refresh() {
    setRefreshing(true);
    setError(false);
    setReload((value) => value + 1);
  }

  return (
    <div className="space-y-5 rounded-md border border-border bg-sheet p-4 sm:p-5">
      <ConnectorSelect
        label="Provider"
        disabled={!inventory}
        onChange={(event) => setProvider(event.target.value === "linear" ? "linear" : "github")}
        value={provider}
      >
        <option value="github">GitHub</option>
        <option value="linear">Linear</option>
      </ConnectorSelect>
      {error ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-danger" role="alert">
            Connector resources are unavailable.
          </p>
          <button className="ui-button" onClick={refresh} type="button">
            Reload resources
          </button>
        </div>
      ) : inventory ? (
        <ProviderResources
          factoryEndpoint={factoryEndpoint}
          inventory={inventory}
          key={provider}
          onChanged={refresh}
          provider={provider}
          refreshing={refreshing}
          workspaceSlug={workspaceSlug}
        />
      ) : (
        <p className="text-sm text-muted" role="status">
          Loading connector resources…
        </p>
      )}
    </div>
  );
}

function ProviderResources({
  factoryEndpoint,
  inventory,
  onChanged,
  provider,
  refreshing,
  workspaceSlug,
}: {
  factoryEndpoint: string;
  inventory: ConnectorInventory;
  onChanged: () => void;
  provider: ConnectorProvider;
  refreshing: boolean;
  workspaceSlug: string;
}) {
  const [selected, setSelected] = useState("");
  const [policyRevision, setPolicyRevision] = useState(0);
  const endpoint = `${factoryEndpoint}/connectors`;
  const resources = inventory.resources.filter((resource) => resource.provider === provider);
  const installations = inventory.installations.filter(
    (installation) => installation.provider === provider,
  );
  const resource = resources.find(({ id }) => id === selected) ?? resources[0];
  const installation =
    installations.find(({ id }) => id === resource?.installationId) ??
    installations.find(({ status }) => status === "connected") ??
    (installations.length === 1 ? installations[0] : undefined);
  const status = resource?.connectionStatus ?? installation?.status;
  const canUseProvider = resource?.enabled === true && status === "connected";

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {resource ? (
          <ConnectorSelect
            className="block max-w-xl space-y-1.5 text-sm font-medium text-foreground"
            label="Provider resource"
            onChange={(event) => setSelected(event.target.value)}
            value={resource.id}
          >
            {resources.map((item) => (
              <option key={item.id} value={item.id}>
                {resourceLabel(item)}
                {item.enabled ? "" : " (disabled)"}
              </option>
            ))}
          </ConnectorSelect>
        ) : (
          <p className="text-sm text-muted">
            No {providerLabel[provider]} resources mapped to this factory.
          </p>
        )}
        {resource && !resource.label && resource.provider === "linear" ? (
          <p className="break-all text-xs text-muted">Provider resource ID {resource.externalId}</p>
        ) : null}
        {status ? (
          <p className="text-sm text-muted">
            <strong className="font-medium text-foreground">{connectionStatusLabel[status]}</strong>
            {resource && !resource.enabled ? " · Mapping disabled" : null}
          </p>
        ) : null}
        {!inventory.canConfigure ? (
          <p className="text-sm text-muted">Workspace admins can change connector setup.</p>
        ) : null}
      </div>
      {resource ? (
        <ConnectorDeliveryHistory
          endpoint={`${endpoint}/${resource.id}`}
          key={`${resource.id}:${resource.mappingRevision}:${status}:${policyRevision}`}
          workspaceSlug={workspaceSlug}
        />
      ) : null}
      {inventory.canConfigure ? (
        <ConnectorSetup
          disabled={refreshing}
          endpoint={endpoint}
          installation={installation}
          installations={installations}
          onChanged={(resourceId) => {
            if (resourceId) setSelected(resourceId);
            onChanged();
          }}
          provider={provider}
          resource={resource}
          resources={resources}
        />
      ) : null}
      {inventory.canConfigure &&
      resource?.provider === "github" &&
      (canUseProvider || resource.githubRequests.some((rule) => rule.enabled)) ? (
        <GitHubRequestRule
          canManageLabels={canUseProvider}
          disabled={refreshing}
          endpoint={endpoint}
          key={resource.id}
          onChanged={onChanged}
          resource={resource}
        />
      ) : null}
      {inventory.canConfigure && resource?.provider === "linear" && canUseProvider ? (
        <LinearConnectorPolicies
          factoryEndpoint={factoryEndpoint}
          onChanged={() => setPolicyRevision((value) => value + 1)}
          key={`${resource.id}:${resource.mappingRevision}`}
          resource={resource}
        />
      ) : null}
    </div>
  );
}
