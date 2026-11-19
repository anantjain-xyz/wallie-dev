import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET } from "./[exportId]/route";
import { POST } from "./route";

const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  rpc: vi.fn(),
  abortSignal: vi.fn(),
}));
vi.mock("@/lib/factories/route-context", () => ({ resolveFactoryRouteContext: mocks.scope }));

const workspaceId = "58200000-0000-4000-8000-000000000001";
const factoryId = "58200000-0000-4000-8000-000000000002";
const exportId = "58200000-0000-4000-8000-000000000003";
const requestId = "58200000-0000-4000-8000-000000000004";
const path =
  "https://wallie.test/api/workspaces/" +
  workspaceId +
  "/factories/" +
  factoryId +
  "/analytics-exports";
const createdAt = "2026-11-19T21:01:00.123456+00:00";
const expiresAt = "2026-11-20T21:01:00.123456+00:00";
const receipt = { id: exportId, createdAt, expiresAt };
const filters = {
  from: "2026-11-01",
  to: "2026-11-07",
  dimension: "model",
  compare: "previous",
  environment: "production",
};
const window = { from: "2026-11-01T00:00:00+00:00", to: "2026-11-07T00:00:00+00:00" };
const params = { params: Promise.resolve({ workspaceId, factoryId, exportId }) };

function capture(input: unknown, mediaType = "application/json") {
  return POST(
    new Request(path, {
      method: "POST",
      headers: { "Content-Type": mediaType },
      body: JSON.stringify(input),
    }),
    params,
  );
}

function download(format: string) {
  return GET(new Request(path + "/" + exportId + "?format=" + format), params);
}

const snapshot = {
  schemaVersion: 1,
  id: exportId,
  workspaceId,
  factoryId,
  capturedAt: createdAt,
  expiresAt,
  filters: {
    ...window,
    dimension: "model",
    deploymentEnvironment: "production",
    comparePrevious: false,
  },
  periods: [
    {
      key: "primary",
      window,
      rolesVisibility: "redacted",
      summaries: {
        flow: { metricRevisions: { workflow_flow: 1 } },
        throughput: { metricRevision: 2 },
        cost: {
          costs: { delivery: { metricRevision: 3, knownCostPerObservedMergeUsd: "EXACT_RATIO" } },
        },
        revert: {},
      },
      evidence: {
        flow: [
          {
            sessionId: " \t=SUM(1,2)",
            note: 'comma, quote " and new\nline',
            status: "measured",
            seconds: 1.23,
          },
        ],
        merge: [],
        deployment: [],
        deliveryCost: [
          {
            run_id: requestId,
            merge_observation_id: exportId,
            cost_state: "estimated",
            cost_usd: "EXACT_COST",
          },
        ],
        operatingCost: [],
        costMerges: [],
        throughput: [],
        revert: [],
      },
    },
  ],
};
const frozenJson = JSON.stringify(snapshot, null, 2)
  .replace('"EXACT_RATIO"', "0.03333333333333333333")
  .replace('"EXACT_COST"', "12.34000000123456789012");

beforeEach(() => {
  vi.clearAllMocks();
  mocks.scope.mockResolvedValue({
    ok: true,
    workspaceId,
    factoryId,
    access: { supabase: { rpc: mocks.rpc } },
  });
  mocks.rpc.mockReturnValue({ abortSignal: mocks.abortSignal });
  mocks.abortSignal.mockResolvedValue({ data: receipt, error: null });
});

describe("analytics snapshot capture route", () => {
  it("forwards the normalized UTC comparison and request UUID using the scoped client", async () => {
    const response = await capture({ ...filters, requestId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual(receipt);
    expect(mocks.rpc).toHaveBeenCalledWith("create_factory_analytics_export", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_request_id: requestId,
      p_from: "2026-11-01T00:00:00.000Z",
      p_to: "2026-11-07T00:00:00.000Z",
      p_dimension: "model",
      p_environment: "production",
      p_compare_previous: true,
    });
    expect(mocks.abortSignal).toHaveBeenCalledWith(expect.any(AbortSignal));
  });

  it("bounds body bytes and rejects advanced drilldown scope and invalid filters before capture", async () => {
    expect((await capture({ ...filters, requestId, environment: "é".repeat(3000) })).status).toBe(
      413,
    );
    expect((await capture({ ...filters, requestId }, "text/plain")).status).toBe(415);
    expect((await capture({ ...filters, requestId, metric: "flow" })).status).toBe(400);
    expect((await capture({ ...filters, requestId, to: "2028-01-01" })).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it.each([
    ["PT404", 404],
    ["PT409", 409],
    ["PT410", 410],
    ["PT422", 422],
    ["PT429", 429],
  ])("preserves snapshot control status for SQL code %s", async (code, status) => {
    mocks.abortSignal.mockResolvedValue({
      data: null,
      error: { code, message: "private details" },
    });
    const response = await capture({ ...filters, requestId });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain("private details");
  });
});

describe("analytics snapshot downloads", () => {
  it("checks the same immutable snapshot on each download and serves authentic JSON bytes", async () => {
    mocks.abortSignal.mockResolvedValue({ data: frozenJson, error: null });
    for (let count = 0; count < 2; count++) {
      const response = await download("json");
      expect(response.status).toBe(200);
      expect(response.headers.get("content-disposition")).toBe(
        'attachment; filename="wallie-analytics-' + exportId + '.json"',
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await response.text()).toBe(frozenJson);
    }
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
    expect(mocks.rpc).toHaveBeenCalledWith("read_factory_analytics_export", {
      p_workspace_id: workspaceId,
      p_factory_id: factoryId,
      p_export_id: exportId,
    });
  });

  it("emits exact decimals, safely quoted Unicode and formula-neutralized cells for the same snapshot", async () => {
    mocks.abortSignal.mockResolvedValue({ data: frozenJson, error: null });
    const response = await download("csv");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/csv");
    expect(response.headers.get("content-disposition")).toContain(exportId + ".csv");
    const contents = await response.text();
    expect(contents).toContain("schema_version,snapshot_id,workspace_id");
    expect(contents).toContain("\r\n");
    expect(contents).toContain('"redacted","observation","flow","1","\' \t=SUM(1,2)"');
    expect(contents).toContain('comma, quote \\"" and new\\nline');
    expect(contents).toContain('"observation","deliveryCost","3"');
    expect(contents).toContain('""knownCostPerObservedMergeUsd"":0.03333333333333333333');
    expect(contents).toContain("source_state,elapsed_seconds,cost_usd,record_json");
    expect(contents).toContain('"measured","1.23",""');
    expect(contents).toContain('"estimated","","12.34000000123456789012"');
    expect(contents).not.toContain(":0.03333333333333333,");
  });

  it("returns a non-attachment response once access is revoked or the snapshot disappears", async () => {
    mocks.abortSignal.mockResolvedValueOnce({ data: frozenJson, error: null });
    expect((await download("json")).status).toBe(200);
    mocks.abortSignal.mockResolvedValueOnce({ data: null, error: null });
    const missing = await download("csv");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-disposition")).toBeNull();
    expect(missing.headers.get("cache-control")).toBe("private, no-store");

    mocks.scope.mockResolvedValueOnce({ ok: false, response: new Response(null, { status: 404 }) });
    const revoked = await download("json");
    expect(revoked.status).toBe(404);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded snapshots, mismatched factory identity, and format ambiguity", async () => {
    mocks.abortSignal.mockResolvedValueOnce({
      data: JSON.stringify({
        ...snapshot,
        periods: [
          {
            ...snapshot.periods[0],
            evidence: {
              ...snapshot.periods[0]?.evidence,
              flow: Array.from({ length: 101 }, () => ({})),
            },
          },
        ],
      }),
      error: null,
    });
    expect((await download("csv")).status).toBe(500);

    mocks.abortSignal.mockResolvedValueOnce({
      data: JSON.stringify({ ...snapshot, extra: "é".repeat(530_000) }),
      error: null,
    });
    expect((await download("json")).status).toBe(500);

    mocks.abortSignal.mockResolvedValueOnce({
      data: JSON.stringify({ ...snapshot, factoryId: requestId }),
      error: null,
    });
    expect((await download("json")).status).toBe(500);

    expect((await download("csv&format=json")).status).toBe(400);
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
  });
});
