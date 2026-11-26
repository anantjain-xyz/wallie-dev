"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import { SelectField } from "@/components/ui/select";
import {
  connectorInventorySchema,
  type ConnectorInventory,
} from "@/lib/connectors/diagnostics-contracts";

import { CatalogStatus, ResourceIdDetails, useConnectorCatalog } from "./catalog";
import { ConnectorDeliveryHistory } from "./history";
import { LinearConnectorPolicies } from "./linear-policies";
import { readConnectorResponse } from "./request";
import { ConnectorSetup, GitHubRequestRule } from "./setup";
import { SlackConnectorAccess, slackWorkspaceOption, useSlackConnectorSetup } from "./slack-access";

export type ConnectorInstallation = ConnectorInventory["installations"][number];
export type ConnectorResource = ConnectorInventory["resources"][number];
export type ConnectorProvider = ConnectorResource["provider"];

const providerLabel = { github: "GitHub", linear: "Linear", slack: "Slack" };
const providerOptions = Object.entries(providerLabel).map(([value, label]) => ({ label, value }));
const kindLabel = {
  repository: "Repository",
  team: "Team",
  project: "Project",
  channel: "Channel",
};

export const connectionStatusLabel: Record<ConnectorResource["connectionStatus"], string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  credential_unavailable: "Access unavailable",
};

export function resourceLabel(resource: ConnectorResource) {
  return (
    resource.label?.trim() ||
    `Unnamed ${providerLabel[resource.provider]} ${kindLabel[resource.kind].toLowerCase()} mapping`
  );
}

export function ConnectorResources({
  canManage,
  factoryId,
  workspaceId,
  workspaceSlug,
}: {
  canManage: boolean;
  factoryId: string;
  workspaceId: string;
  workspaceSlug: string;
}) {
  const search = useSearchParams();
  const [selectedProvider, setProvider] = useState<ConnectorProvider>();
  const fromSlack = search.get("connector") === "slack";
  const provider = selectedProvider ?? (fromSlack ? "slack" : "github");
  const slackResult = fromSlack ? search.get("slackResult") : null;
  const [inventory, setInventory] = useState<ConnectorInventory | null>(null);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const factoryEndpoint = `/api/workspaces/${workspaceId}/factories/${factoryId}`;
  const endpoint = `${factoryEndpoint}/connectors`;

  useEffect(() => {
    if (!canManage) return;
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
  }, [canManage, endpoint, reload]);

  function refresh() {
    setRefreshing(true);
    setError(false);
    setReload((value) => value + 1);
  }

  if (!canManage) {
    return (
      <div className="rounded-md border border-border bg-sheet p-4 sm:p-5">
        <SlackConnectorAccess endpoint={endpoint} result={slackResult} />
      </div>
    );
  }

  return (
    <div className="space-y-5 rounded-md border border-border bg-sheet p-4 sm:p-5">
      <SelectField
        className="max-w-xs"
        disabled={!inventory}
        label="Provider"
        onValueChange={(next) => {
          if (next === provider) return;
          if (next === "github" || next === "linear" || next === "slack") setProvider(next);
        }}
        options={providerOptions}
        value={provider}
      />
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
          slackResult={slackResult}
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
  slackResult,
  workspaceSlug,
}: {
  factoryEndpoint: string;
  inventory: ConnectorInventory;
  onChanged: () => void;
  provider: ConnectorProvider;
  refreshing: boolean;
  slackResult: string | null;
  workspaceSlug: string;
}) {
  const [selected, setSelected] = useState("");
  const [knownNames, setKnownNames] = useState<Record<string, string>>({});
  const [selectedInstallation, setSelectedInstallation] = useState("");
  const [policyRevision, setPolicyRevision] = useState(0);
  const endpoint = `${factoryEndpoint}/connectors`;
  const providerResources = inventory.resources.filter(
    (resource) => resource.provider === provider,
  );
  const installations = inventory.installations.filter(
    (installation) => installation.provider === provider,
  );
  const slackSetup = useSlackConnectorSetup(
    provider === "slack" && !refreshing ? endpoint : null,
    installations
      .map(({ id, status, generation }) => `${id}:${status}:${generation}`)
      .sort()
      .join(","),
  );
  const selectedResource =
    providerResources.find(({ id }) => id === selected) ?? providerResources[0];
  const installation =
    installations.find(({ id }) => id === selectedInstallation) ??
    installations.find(({ id }) => id === selectedResource?.installationId) ??
    installations.find(({ status }) => status === "connected") ??
    (provider === "slack" || installations.length === 1 ? installations[0] : undefined);
  const resources =
    provider === "slack" && installation
      ? providerResources.filter(({ installationId }) => installationId === installation.id)
      : providerResources;
  const resource = resources.find(({ id }) => id === selected) ?? resources[0];
  const status = resource?.connectionStatus ?? installation?.status;
  const canUseProvider = resource?.enabled === true && status === "connected";
  const verified = useConnectorCatalog(
    endpoint,
    inventory.canConfigure &&
      resource &&
      !resource.label &&
      status === "connected" &&
      provider !== "github"
      ? new URLSearchParams({ provider, kind: "resource", resourceId: resource.id }).toString()
      : null,
  );
  const verifiedName = verified.catalog?.resources.find(
    (item) => item.id === resource?.externalId,
  )?.label;
  const verifiedContext = verified.catalog?.tenant.label;

  function rememberResourceName() {
    if (!resource || !verifiedName) return;
    setKnownNames((current) => ({ ...current, [resource.id]: verifiedName }));
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        {provider === "slack" && installations.length > 1 ? (
          <SelectField
            className="max-w-xs"
            fallbackLabel="Choose a workspace"
            label="Slack workspace"
            onValueChange={(installationId) => {
              if (installationId === installation?.id) return;
              rememberResourceName();
              setSelectedInstallation(installationId);
            }}
            options={installations.map((item) => {
              const workspace = slackSetup.setup?.installations.find(
                (entry) => entry.id === item.id,
              );
              return {
                label: workspace
                  ? slackWorkspaceOption(workspace)
                  : `${slackSetup.setup || slackSetup.loadFailed ? "Workspace name unavailable" : "Loading Slack workspace…"} · ${connectionStatusLabel[item.status]}`,
                value: item.id,
              };
            })}
            value={installation?.id ?? ""}
            wrap
          />
        ) : null}
        {resource ? (
          <SelectField
            className="max-w-xl"
            label="Provider resource"
            onValueChange={(resourceId) => {
              if (resourceId === resource.id) return;
              rememberResourceName();
              setSelected(resourceId);
            }}
            options={resources.map((item) => {
              const name =
                (item.id === resource.id ? verifiedName : undefined) ??
                knownNames[item.id] ??
                resourceLabel(item);
              return { label: item.enabled ? name : `${name} (disabled)`, value: item.id };
            })}
            value={resource.id}
            wrap
          />
        ) : (
          <p className="text-sm text-muted">
            No {providerLabel[provider]} resources mapped to this factory.
          </p>
        )}
        {resource ? (
          <>
            {verifiedName || knownNames[resource.id] || resource.label ? (
              <p className="text-xs text-muted">
                {providerLabel[provider]} {kindLabel[resource.kind].toLowerCase()}
                {verifiedContext && verifiedContext !== installation?.externalTenantId
                  ? ` · ${verifiedContext}`
                  : ""}
              </p>
            ) : null}
            {!resource.label && !verifiedName && !knownNames[resource.id] && !verified.loading ? (
              <p className="text-xs text-muted">
                {inventory.canConfigure
                  ? "To identify or replace this mapping, find the resource by name below. The current mapping won’t change automatically."
                  : "A workspace admin can find this resource by name in connector setup."}
              </p>
            ) : null}
            <ResourceIdDetails ids={[resource.externalId]} label="Provider resource ID" />
            <CatalogStatus catalog={verified} label="mapped resource name" />
          </>
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
      {provider === "slack" ? (
        <SlackConnectorAccess
          canManage
          endpoint={endpoint}
          installationId={installation?.id}
          key={`${installation?.id}:${installation?.generation}:${installation?.status}`}
          result={slackResult}
          setupState={slackSetup}
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
          onSelectMapped={(resourceId, name) => {
            setKnownNames((current) => ({ ...current, [resourceId]: name }));
            setSelected(resourceId);
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
