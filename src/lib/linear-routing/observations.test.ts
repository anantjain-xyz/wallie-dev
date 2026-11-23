import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchLinearStateObservations, LinearRateLimitedError } from "./observations";

const stamp = "2026-10-02T00:00:00Z";
const span = { id: "span-1", stateId: "state-1", startedAt: stamp, endedAt: null };
const issueId = "66310000-0000-4000-8000-000000000001";
const issue = {
  id: issueId,
  updatedAt: stamp,
  state: { id: "state-1", name: "Rework" },
  team: { id: "team-1" },
  project: null,
  stateHistory: { nodes: [span], pageInfo: { hasNextPage: false, endCursor: null } },
};
const fetchMock = vi.fn();
const sleep = vi.fn().mockResolvedValue(undefined);
const response = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200 });
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("fetchLinearStateObservations", () => {
  it("batches identifier-safe issue lookups with state-span identity", async () => {
    fetchMock.mockResolvedValue(
      response({ issue0: issue, issue1: { ...issue, id: "66310000-0000-4000-8000-000000000002" } }),
    );
    const result = await fetchLinearStateObservations("secret", ["ENG-123", "uuid"], sleep);
    expect(result.get("ENG-123")).toEqual({
      issueId,
      issueUpdatedAt: stamp,
      spanId: "span-1",
      startedAt: stamp,
      stateId: "state-1",
      statusName: "Rework",
      teamId: "team-1",
      projectId: null,
    });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.query).toContain("issue0: issue(id: $id0)");
    expect(body.variables).toEqual({ id0: "ENG-123", id1: "uuid" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("keeps span identity through unrelated issue edits", async () => {
    fetchMock.mockResolvedValue(
      response({ issue0: { ...issue, updatedAt: "2026-10-02T01:00:00Z" } }),
    );
    expect(
      (await fetchLinearStateObservations("key", ["ENG-123"], sleep)).get("ENG-123")?.spanId,
    ).toBe("span-1");
  });
  it("distinguishes a missed leave and return to the same state", async () => {
    fetchMock.mockResolvedValue(
      response({
        issue0: {
          ...issue,
          stateHistory: { ...issue.stateHistory, nodes: [{ ...span, id: "span-return" }] },
        },
      }),
    );
    expect(
      (await fetchLinearStateObservations("key", ["ENG-123"], sleep)).get("ENG-123")?.spanId,
    ).toBe("span-return");
  });
  it("paginates history without assuming newest-first ordering", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          issue0: {
            ...issue,
            stateHistory: {
              nodes: [{ ...span, endedAt: stamp }],
              pageInfo: { hasNextPage: true, endCursor: "older-page" },
            },
          },
        }),
      )
      .mockResolvedValueOnce(response({ issue }));
    expect(
      (await fetchLinearStateObservations("key", ["ENG-123"], sleep)).get("ENG-123")?.spanId,
    ).toBe("span-1");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body).variables).toEqual({
      id: issueId,
      after: "older-page",
    });
  });
  it("rejects a changed source snapshot during pagination", async () => {
    fetchMock
      .mockResolvedValueOnce(
        response({
          issue0: {
            ...issue,
            stateHistory: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "page" } },
          },
        }),
      )
      .mockResolvedValueOnce(response({ issue: { ...issue, updatedAt: "2026-10-02T01:00:00Z" } }));
    await expect(fetchLinearStateObservations("key", ["ENG-123"], sleep)).rejects.toThrow(
      "changed while reading",
    );
  });
  it.each([
    { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    {
      nodes: [{ ...span, stateId: "wrong-state" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
    {
      nodes: [span, { ...span, id: "duplicate-open" }],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  ])("fails closed on missing or inconsistent current span %#", async (stateHistory) => {
    fetchMock.mockResolvedValue(response({ issue0: { ...issue, stateHistory } }));
    await expect(fetchLinearStateObservations("key", ["ENG-123"], sleep)).rejects.toThrow();
  });
  it("rejects repeated cursors rather than looping", async () => {
    const paged = {
      ...issue,
      stateHistory: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "same" } },
    };
    fetchMock
      .mockResolvedValueOnce(response({ issue0: paged }))
      .mockResolvedValueOnce(response({ issue: paged }));
    await expect(fetchLinearStateObservations("key", ["ENG-123"], sleep)).rejects.toThrow(
      "unavailable",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("skips an issue explicitly absent from Linear", async () => {
    fetchMock.mockResolvedValue(response({ issue0: null }));
    expect((await fetchLinearStateObservations("key", ["ENG-123"], sleep)).size).toBe(0);
  });
  it("returns the first rate limit without retrying when no sleep is configured", async () => {
    fetchMock.mockResolvedValue(
      new Response("", { status: 429, headers: { "Retry-After": "30" } }),
    );
    await expect(fetchLinearStateObservations("key", ["ENG-123"])).rejects.toBeInstanceOf(
      LinearRateLimitedError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("retries HTTP throttling once and caps the wait", async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response("", { status: 429, headers: { "Retry-After": "100000" } }),
      )
      .mockResolvedValueOnce(response({ issue0: issue }));
    await fetchLinearStateObservations("key", ["ENG-123"], sleep);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(30_000);
  });
  it("recognizes repeated GraphQL throttling", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(
          JSON.stringify({ errors: [{ message: "limit", extensions: { code: "RATELIMITED" } }] }),
        ),
    );
    await expect(fetchLinearStateObservations("key", ["ENG-123"], sleep)).rejects.toBeInstanceOf(
      LinearRateLimitedError,
    );
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1_000);
  });
  it("does not interpret failed or incomplete reads as an observation", async () => {
    fetchMock.mockResolvedValue(response({}));
    await expect(fetchLinearStateObservations("key", ["ENG-123"], sleep)).rejects.toThrow();
  });
});
