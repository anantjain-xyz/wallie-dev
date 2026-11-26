"use client";

import { useEffect, useState } from "react";

import {
  connectorCatalogResponseSchema,
  type ConnectorCatalogOption,
  type ConnectorCatalogResponse,
} from "@/lib/connectors/setup-contracts";

import { readConnectorResponse } from "./request";

type CatalogResult = {
  catalog: ConnectorCatalogResponse | null;
  loadFailed: boolean;
  scope: string;
  request: number;
};

function mergeOptions(known: ConnectorCatalogOption[], incoming: ConnectorCatalogOption[]) {
  return [...new Map([...known, ...incoming].map((item) => [item.id, item])).values()];
}

export function useConnectorCatalog(endpoint: string, query: string | null, findIds = "") {
  const scope = JSON.stringify([endpoint, query, findIds]);
  const [request, setRequest] = useState({ scope, cursor: null as string | null, number: 0 });
  const [result, setResult] = useState<CatalogResult | null>(null);
  if (request.scope !== scope) setRequest({ scope, cursor: null, number: request.number + 1 });
  const cursor = request.scope === scope ? request.cursor : null;
  const number = request.number;
  const scopedResult = result?.scope === scope ? result : null;
  const settled = scopedResult?.request === number;
  const catalog = settled || cursor ? (scopedResult?.catalog ?? null) : null;
  const loading = query !== null && !settled;
  const loadFailed = settled && scopedResult?.loadFailed === true;

  useEffect(() => {
    if (!query) return;
    const abort = new AbortController();
    const params = new URLSearchParams(query);
    const targets = findIds ? findIds.split(",") : [];
    async function read() {
      let lastPage: ConnectorCatalogResponse | undefined;
      let resources: ConnectorCatalogOption[] = [];
      let tenantId: string | undefined;
      let after = cursor;
      const seen = new Set<string>();
      for (let page = 0; page < 6; page++) {
        if (after) {
          if (seen.has(after)) throw new Error("Connector catalog cursor repeated.");
          seen.add(after);
          params.set("cursor", after);
        }
        const data = await fetch(`${endpoint}/catalog?${params}`, { signal: abort.signal }).then(
          (response) => readConnectorResponse(response, connectorCatalogResponseSchema),
        );
        if (
          data.provider !== params.get("provider") ||
          data.kind !== params.get("kind") ||
          (tenantId !== undefined && tenantId !== data.tenant.id)
        )
          throw new Error("Connector catalog scope changed.");
        tenantId = data.tenant.id;
        resources = mergeOptions(resources, data.resources);
        lastPage = data;
        after = data.nextCursor;
        if (cursor || !after || targets.every((id) => resources.some((item) => item.id === id)))
          break;
      }
      return lastPage ? { ...lastPage, resources } : null;
    }

    void read().then(
      (data) => {
        if (abort.signal.aborted || !data) return;
        setResult((current) => {
          const previous = cursor && current?.scope === scope ? current.catalog : null;
          if (previous && previous.tenant.id !== data.tenant.id)
            return { catalog: null, loadFailed: true, request: number, scope };
          const resources = previous
            ? mergeOptions(previous.resources, data.resources)
            : data.resources;
          return { catalog: { ...data, resources }, loadFailed: false, request: number, scope };
        });
      },
      () => {
        if (abort.signal.aborted) return;
        setResult((current) => ({
          catalog: cursor && current?.scope === scope ? current.catalog : null,
          loadFailed: true,
          request: number,
          scope,
        }));
      },
    );
    return () => abort.abort();
  }, [cursor, endpoint, findIds, number, query, scope]);

  return {
    catalog,
    loadFailed,
    loading,
    load: (next: string | null = null) => setRequest({ scope, cursor: next, number: number + 1 }),
    retry: () => setRequest({ scope, cursor, number: number + 1 }),
  };
}

export function CatalogStatus({
  catalog,
  label,
}: {
  catalog: ReturnType<typeof useConnectorCatalog>;
  label: string;
}) {
  if (catalog.loadFailed)
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-xs text-danger" role="alert">
          Could not load {label} for this resource.
        </p>
        <button className="ui-button" onClick={catalog.retry} type="button">
          Retry {label} lookup
        </button>
      </div>
    );
  if (catalog.loading)
    return (
      <p className="text-xs text-muted" role="status">
        Loading {label}…
      </p>
    );
  const cursor = catalog.catalog?.nextCursor;
  if (cursor)
    return (
      <button className="ui-button" onClick={() => catalog.load(cursor)} type="button">
        Load more {label}
      </button>
    );
  return null;
}

export function ResourceIdDetails({
  ids,
  label = "Provider ID",
}: {
  ids: string[];
  label?: string;
}) {
  if (ids.length === 0) return null;
  return (
    <details className="text-xs text-muted">
      <summary className="cursor-pointer">
        {label}
        {ids.length > 1 ? "s" : ""}
      </summary>
      <ul className="mt-1 space-y-1">
        {ids.map((id) => (
          <li className="break-all" key={id}>
            <code className="select-all">{id}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}
