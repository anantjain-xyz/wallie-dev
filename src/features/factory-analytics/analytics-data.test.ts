import { createServerClient } from "@supabase/ssr";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import { loadAnalyticsEvidence, loadAnalyticsPeriods } from "./analytics-data";
import { parseAnalyticsQuery } from "./analytics-query";

const workspaceId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const factoryId = "aaaaaaaa-aaaa-aaaa-aaaa-bbbbbbbbbbbb";
const alternateFactory = "aaaaaaaa-aaaa-aaaa-aaaa-cccccccccccc";
const sessionId = "aaaaaaaa-aaaa-aaaa-aaaa-dddddddddddd";
const observationId = "aaaaaaaa-aaaa-aaaa-aaaa-eeeeeeeeeeee";
const dates = { from: "2026-10-01", to: "2026-10-08" };

function query(filters: Record<string, string | undefined> = {}) {
  const result = parseAnalyticsQuery({ ...dates, ...filters });
  if (!result.success) throw new Error("Expected a valid analytics query.");
  return result.data;
}

function requestUrl(input: Parameters<typeof fetch>[0]) {
  return new URL(input instanceof Request ? input.url : input);
}

function harness(handle: (path: string) => unknown) {
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const data = handle(requestUrl(input).pathname);
    if (data === undefined)
      return Response.json({ code: "PT404", message: "Unavailable" }, { status: 404 });
    return Response.json(data);
  });
  const supabase = createServerClient<Database>("https://wallie.test", "test-anon-key", {
    global: { fetch },
    cookies: { getAll: () => [], setAll: () => undefined },
  });
  return { fetch, supabase, workspaceId, factoryId };
}

function rpcBodies(fetch: ReturnType<typeof harness>["fetch"], name: string): unknown[] {
  return fetch.mock.calls
    .filter(([input]) => requestUrl(input).pathname.endsWith("/rpc/" + name))
    .map(([, request]) => (typeof request?.body === "string" ? JSON.parse(request.body) : null));
}

describe("factory analytics reads", () => {
  it("loads one same-sized prior period with the same authenticated filters and isolates unavailable data", async () => {
    const client = harness((path) =>
      path.endsWith("/get_factory_throughput_breakdown")
        ? {
            metricKey: "canonical_merge_throughput",
            metricRevision: 1,
            dimension: "model",
            window: { from: "2026-10-01T00:00:00Z", to: "2026-10-08T00:00:00Z" },
            observedMergeCount: 0,
            mixedMergeCount: 0,
            partialMergeCount: 0,
            bucketMembershipCount: 0,
            bucketCount: 0,
            bucketsTruncated: false,
            omittedBucketMembershipCount: 0,
            buckets: [],
            coverage: { captureStartedAt: null, unresolvedMergeCount: 0, partial: true },
            evaluatedAt: "2026-11-19T20:01:30Z",
          }
        : undefined,
    );

    const result = await loadAnalyticsPeriods({
      ...client,
      query: query({ compare: "previous", dimension: "model", environment: "production" }),
    });
    expect(client.fetch).toHaveBeenCalledTimes(8);
    expect(rpcBodies(client.fetch, "get_factory_flow_summary")).toEqual([
      {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_environment: "production",
        p_from: "2026-10-01T00:00:00.000Z",
        p_to: "2026-10-08T00:00:00.000Z",
      },
      {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_environment: "production",
        p_from: "2026-09-24T00:00:00.000Z",
        p_to: "2026-10-01T00:00:00.000Z",
      },
    ]);
    expect(rpcBodies(client.fetch, "get_factory_throughput_breakdown")).toEqual([
      expect.objectContaining({ p_dimension: "model" }),
      expect.objectContaining({ p_dimension: "model" }),
    ]);
    expect(result.primary).toMatchObject({
      flow: { status: "unavailable" },
      cost: { status: "unavailable" },
      throughput: { status: "ready", data: { observedMergeCount: 0, coverage: { partial: true } } },
      revert: { status: "unavailable" },
    });
  });

  it("only requests selected flow evidence, preserves microseconds, and rejects a cross-scope cursor", async () => {
    const at = "2026-10-01T00:00:00.000017+00:00";
    const endAt = "2026-10-01T00:00:00.123456+00:00";
    const client = harness((path) => {
      if (path.endsWith("/list_factory_flow_evidence"))
        return {
          metricRevision: 1,
          items: [
            {
              sessionId,
              phase: "queued",
              status: "measured",
              startedAt: at,
              endedAt: endAt,
              sourceStartedAt: at,
              sourceEndedAt: endAt,
              seconds: 0.123439,
              observationIds: [observationId],
            },
          ],
          nextCursor: { at, sessionId, endAt },
        };
      if (path.endsWith("/sessions")) return [{ id: sessionId, number: 42 }];
      return undefined;
    });
    expect(await loadAnalyticsEvidence({ ...client, query: query() })).toBeNull();
    expect(client.fetch).not.toHaveBeenCalled();
    const selected = { metric: "flow", facet: "queued" };
    const first = await loadAnalyticsEvidence({ ...client, query: query(selected) });
    expect(first).toMatchObject({
      status: "ready",
      data: {
        metric: "flow",
        items: [{ observationIds: [observationId] }],
        sessionNumbers: { [sessionId]: 42 },
      },
    });
    if (first?.status !== "ready" || !first.data.nextCursor)
      throw new Error("Expected an evidence cursor.");

    await loadAnalyticsEvidence({
      ...client,
      query: query({ ...selected, cursor: first.data.nextCursor }),
    });
    expect(rpcBodies(client.fetch, "list_factory_flow_evidence")).toEqual([
      expect.objectContaining({ p_metric_key: "workflow_flow", p_facet: "queued", p_limit: 25 }),
      expect.objectContaining({
        p_cursor_at: at,
        p_cursor_end_at: endAt,
        p_cursor_session_id: sessionId,
        p_facet: "queued",
      }),
    ]);
    const sessionUrl = client.fetch.mock.calls.find(([input]) =>
      requestUrl(input).pathname.endsWith("/sessions"),
    )?.[0];
    expect(sessionUrl).toBeDefined();
    const sessionQuery = requestUrl(sessionUrl ?? "https://wallie.test").searchParams;
    expect(sessionQuery.get("workspace_id")).toBe("eq." + workspaceId);
    expect(sessionQuery.get("factory_id")).toBe("eq." + factoryId);
    expect(sessionQuery.get("id")).toBe("in.(" + sessionId + ")");

    client.fetch.mockClear();
    expect(
      await loadAnalyticsEvidence({
        ...client,
        factoryId: alternateFactory,
        query: query({ ...selected, cursor: first.data.nextCursor }),
      }),
    ).toEqual({ status: "unavailable" });
    expect(
      await loadAnalyticsEvidence({
        ...client,
        query: query({ ...selected, facet: "active", cursor: first.data.nextCursor }),
      }),
    ).toEqual({ status: "unavailable" });
    expect(client.fetch).not.toHaveBeenCalled();
  });

  it("binds comparison evidence and a verified numerator to the exact filters", async () => {
    const client = harness(() => undefined);
    expect(
      await loadAnalyticsEvidence({
        ...client,
        query: query({
          metric: "revert",
          facet: "covered-verified",
          compare: "previous",
          period: "compare",
        }),
      }),
    ).toEqual({ status: "unavailable" });
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(rpcBodies(client.fetch, "list_factory_revert_evidence")).toEqual([
      {
        p_workspace_id: workspaceId,
        p_factory_id: factoryId,
        p_from: "2026-09-24T00:00:00.000Z",
        p_to: "2026-10-01T00:00:00.000Z",
        p_status: "covered",
        p_has_verified_revert: true,
        p_limit: 25,
      },
    ]);
  });

  it.each([
    {
      filters: { metric: "merge", facet: "measured" },
      rpc: "list_factory_flow_evidence",
      args: { p_metric_key: "request_to_merge", p_facet: "measured" },
    },
    {
      filters: { metric: "deployment", facet: "censored" },
      rpc: "list_factory_flow_evidence",
      args: { p_metric_key: "request_to_deployment", p_facet: "censored" },
    },
    {
      filters: { metric: "throughput", dimension: "harness", bucket: "mixed" },
      rpc: "list_factory_throughput_contributions",
      args: { p_dimension: "harness", p_bucket_key: "mixed" },
    },
    {
      filters: { metric: "cost-merges" },
      rpc: "list_factory_cost_merges",
      args: { p_limit: 25 },
    },
  ])("uses the matching evidence RPC for $filters.metric", async ({ filters, rpc, args }) => {
    const client = harness(() => undefined);
    await loadAnalyticsEvidence({ ...client, query: query(filters) });
    expect(client.fetch).toHaveBeenCalledTimes(1);
    expect(rpcBodies(client.fetch, rpc)).toEqual([
      expect.objectContaining({ p_factory_id: factoryId, p_workspace_id: workspaceId, ...args }),
    ]);
  });

  it("uses the exact cost run lookahead for filtered pages", async () => {
    const rows = Array.from({ length: 26 }, (_, i) => ({
      run_id: "11111111-1111-1111-1111-" + String(i + 1).padStart(12, "0"),
      session_id: sessionId,
      attempt_count: 1,
      run_status: "success",
      started_at: "2026-10-01T00:02:00Z",
      finished_at: null,
      merge_id: null,
      merge_observation_id: null,
      candidate_merge_id: null,
      attribution: "unlinked",
      cost_state: "measured",
      cost_usd: 0,
      usage_recorded_at: null,
      usage_finalized_at: null,
      usage_estimation_revision: null,
    }));
    const client = harness((path) =>
      path.endsWith("/list_factory_cost_contributions") ? rows : [],
    );
    const selected = { metric: "operating-cost", facet: "known" };
    const first = await loadAnalyticsEvidence({ ...client, query: query(selected) });
    expect(first).toMatchObject({
      status: "ready",
      data: { metric: "operating-cost", items: expect.any(Array) },
    });
    if (first?.status !== "ready" || !first.data.nextCursor)
      throw new Error("Expected an evidence cursor.");
    expect(first.data.items).toHaveLength(25);
    expect(first.data.items[0]).toMatchObject({ costUsd: 0, attribution: "unlinked" });
    await loadAnalyticsEvidence({
      ...client,
      query: query({ ...selected, cursor: first.data.nextCursor }),
    });
    expect(rpcBodies(client.fetch, "list_factory_cost_contributions")).toEqual([
      expect.objectContaining({ p_basis: "operating", p_facet: "known", p_limit: 26 }),
      expect.objectContaining({
        p_basis: "operating",
        p_facet: "known",
        p_after_run_id: rows[24]?.run_id,
        p_limit: 26,
      }),
    ]);
  });
});
