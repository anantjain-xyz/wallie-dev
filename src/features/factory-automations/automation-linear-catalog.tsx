"use client";

import Link from "next/link";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { SelectField } from "@/components/ui/select";
import { CatalogStatus, useConnectorCatalog } from "@/features/settings/connector-settings/catalog";
import { readConnectorResponse } from "@/features/settings/connector-settings/request";
import {
  connectorInventorySchema,
  type ConnectorInventory,
} from "@/lib/connectors/diagnostics-contracts";
import {
  connectorCatalogResponseSchema,
  type ConnectorCatalogOption,
} from "@/lib/connectors/setup-contracts";
import { automationFilterTextSchema } from "@/lib/factory-automations/contracts";

export const linearKinds = ["state", "team", "project"] as const;
export type LinearKind = (typeof linearKinds)[number];
type Catalog = ReturnType<typeof useConnectorCatalog>;
type Choices = {
  options: ConnectorCatalogOption[];
  known: ConnectorCatalogOption[];
  catalog: Catalog | null;
};
const empty: Choices = { options: [], known: [], catalog: null };
const LinearCatalog = createContext<
  Record<LinearKind, Choices> & {
    canDiscover: boolean;
    setEditorEnabled: (active: boolean) => void;
  }
>({
  canDiscover: false,
  state: empty,
  team: empty,
  project: empty,
  setEditorEnabled: () => undefined,
});

export const useAutomationLinearCatalog = () => useContext(LinearCatalog);

export function linearOptionLabel(option: ConnectorCatalogOption) {
  return option.description ? `${option.label} · ${option.description}` : option.label;
}

function useChoices(
  endpoint: string,
  kind: LinearKind,
  scope: { id: string; tenant: string; generation: number } | undefined,
  saved: string[],
) {
  const query = scope
    ? new URLSearchParams({
        provider: "linear",
        kind,
        ...(kind !== "project" ? { resourceId: scope.id } : {}),
      }).toString()
    : null;
  const catalog = useConnectorCatalog(endpoint, query, saved.join(","));
  const current = scope && catalog.catalog?.tenant.id === scope.tenant ? catalog.catalog : null;
  const [cache, setCache] = useState<{
    key: string;
    current: typeof current;
    known: ConnectorCatalogOption[];
  }>();
  const key = scope ? `${scope.tenant}:${scope.generation}` : "";
  const known = cache?.key === key ? cache.known : [];
  const options = current
    ? current.resources
        .filter(({ id }) => automationFilterTextSchema.safeParse(id).success)
        .map((option) =>
          kind === "project" ? { ...option, description: current.tenant.label } : option,
        )
    : [];

  if (current && (cache?.current !== current || cache?.key !== key)) {
    setCache({
      key,
      current,
      known: [...new Map([...known, ...options].map((item) => [item.id, item])).values()],
    });
  }
  return {
    options,
    known: [...new Map([...known, ...options].map((item) => [item.id, item])).values()],
    catalog: query
      ? current || !catalog.catalog
        ? catalog
        : { ...catalog, catalog: null, loadFailed: true }
      : null,
  };
}

type Mapping = {
  id: string;
  kind: "team" | "project";
  externalId: string;
  tenant: string;
  generation: number;
};

async function readMappingNames(endpoint: string, mappings: Mapping[], signal: AbortSignal) {
  const entries: [string, string][] = [];
  for (let offset = 0; offset < mappings.length && !signal.aborted; offset += 3) {
    await Promise.allSettled(
      mappings.slice(offset, offset + 3).map(async (mapping) => {
        const params = new URLSearchParams({
          provider: "linear",
          kind: "resource",
          resourceId: mapping.id,
        });
        const data = await fetch(`${endpoint}/catalog?${params}`, { signal }).then((response) =>
          readConnectorResponse(response, connectorCatalogResponseSchema),
        );
        const name = data.resources.find(({ id }) => id === mapping.externalId)?.label;
        if (
          data.provider === "linear" &&
          data.kind === "resource" &&
          data.tenant.id === mapping.tenant &&
          name
        ) {
          entries.push([mapping.id, name]);
        }
      }),
    );
  }
  return Object.fromEntries(entries);
}

export function AutomationLinearCatalog({
  children,
  canDiscover,
  endpoint,
  integrationsHref,
  revisionUsesLinear,
  savedIds,
}: {
  children: ReactNode;
  canDiscover: boolean;
  endpoint: string;
  integrationsHref: string;
  revisionUsesLinear: boolean;
  savedIds: Record<LinearKind, string[]>;
}) {
  const [editorEnabled, setEditorEnabled] = useState(false);
  const enabled = revisionUsesLinear || editorEnabled;
  const [request, setRequest] = useState(0);
  const [inventory, setInventory] = useState<{
    request: number;
    data: ConnectorInventory | null;
  }>();
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [selection, setSelection] = useState<string>();

  useEffect(() => {
    if (!enabled || !canDiscover) return;
    const abort = new AbortController();
    void fetch(endpoint, { signal: abort.signal })
      .then((response) => readConnectorResponse(response, connectorInventorySchema))
      .then(
        (data) => {
          if (!abort.signal.aborted) setInventory({ request, data });
        },
        () => {
          if (!abort.signal.aborted) setInventory({ request, data: null });
        },
      );
    return () => abort.abort();
  }, [canDiscover, enabled, endpoint, request]);

  const data = inventory?.request === request ? inventory.data : undefined;
  const mappings: Mapping[] = (
    enabled && canDiscover && data?.canConfigure ? data.resources : []
  ).flatMap((resource) => {
    if (
      resource.provider !== "linear" ||
      (resource.kind !== "team" && resource.kind !== "project") ||
      !resource.enabled ||
      resource.connectionStatus !== "connected"
    )
      return [];
    const installation = data?.installations.find(
      ({ id, provider, status }) =>
        id === resource.installationId && provider === "linear" && status === "connected",
    );
    return installation
      ? [
          {
            id: resource.id,
            kind: resource.kind,
            externalId: resource.externalId,
            tenant: installation.externalTenantId,
            generation: installation.generation,
          },
        ]
      : [];
  });
  const scope =
    mappings.find(({ id }) => id === selection) ??
    mappings.find(({ kind, externalId }) => savedIds[kind].includes(externalId)) ??
    mappings[0];
  const mappingScope = JSON.stringify(mappings);
  useEffect(() => {
    const available = JSON.parse(mappingScope) as Mapping[];
    if (available.length < 2) return;
    const abort = new AbortController();
    void readMappingNames(endpoint, available, abort.signal).then((names) => {
      if (!abort.signal.aborted) setLabels((previous) => ({ ...previous, ...names }));
    });
    return () => abort.abort();
  }, [endpoint, mappingScope]);

  const state = useChoices(endpoint, "state", scope, savedIds.state);
  const team = useChoices(endpoint, "team", scope, savedIds.team);
  const project = useChoices(endpoint, "project", scope, savedIds.project);
  return (
    <LinearCatalog.Provider value={{ canDiscover, state, team, project, setEditorEnabled }}>
      {enabled ? (
        <div className="ui-sheet min-w-0 space-y-3 p-4 text-sm sm:p-6">
          <h3 className="type-label">Linear choices</h3>
          {!canDiscover || (data && !data.canConfigure) ? (
            <p className="text-muted">
              Only workspace owners and admins can look up or change Linear choices here. Ask one to
              configure the filters or run a different Linear sample. Saved values are retained.
            </p>
          ) : data === undefined ? (
            <p className="text-muted" role="status">
              Loading Linear mappings…
            </p>
          ) : data === null ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-danger" role="alert">
                Could not load Linear mappings.
              </p>
              <button className="ui-button" type="button" onClick={() => setRequest(request + 1)}>
                Retry Linear mappings
              </button>
            </div>
          ) : scope ? (
            <>
              <p className="text-muted">
                The mapping limits states and teams. Projects come from the same connected Linear
                workspace. Changing the lookup scope does not change saved filters or sample values.
              </p>
              {mappings.length > 1 ? (
                <SelectField
                  className="max-w-md"
                  label="Linear lookup scope"
                  options={mappings.map(({ id, kind }, index) => ({
                    value: id,
                    label: labels[id]
                      ? `${labels[id]} · ${kind}`
                      : `Mapped ${kind} ${index + 1} · Name unavailable`,
                  }))}
                  value={scope.id}
                  onValueChange={setSelection}
                  wrap
                />
              ) : null}
            </>
          ) : (
            <p className="text-muted">
              No connected, enabled Linear team or project mapping is available for this factory.
            </p>
          )}
          {canDiscover ? (
            <Link className="text-accent underline underline-offset-4" href={integrationsHref}>
              Check Linear in Integrations
            </Link>
          ) : null}
        </div>
      ) : null}
      {children}
    </LinearCatalog.Provider>
  );
}

export function LinearChoiceStatus({ kind }: { kind: LinearKind }) {
  const { catalog, options } = useAutomationLinearCatalog()[kind];
  if (!catalog) return null;
  const label = `Linear ${kind}s`;
  if (!catalog.loadFailed && !catalog.loading && !catalog.catalog?.nextCursor && !options.length) {
    return <p className="text-xs text-muted">No {label} found in this scope.</p>;
  }
  return <CatalogStatus catalog={catalog} label={label} />;
}
