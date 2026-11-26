import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const { requireAccess, enabledProviders } = vi.hoisted(() => ({
  enabledProviders: vi.fn(),
  requireAccess: vi.fn(),
}));

vi.mock("@/lib/sandbox-connections/server", () => ({
  getEnabledSandboxProviders: enabledProviders,
}));
vi.mock("@/lib/workspaces/access", () => ({ requireWorkspaceAccessById: requireAccess }));

const endpoint =
  "https://wallie.test/api/workspaces/workspace-1/sandbox-connections/vercel/targets";
const context = { params: Promise.resolve({ workspaceId: "workspace-1" }) };
const syntheticToken = "synthetic-vercel-token";
const send = (body: unknown) =>
  POST(
    new Request(endpoint, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
    context,
  );

beforeEach(() => {
  requireAccess.mockReset().mockResolvedValue({ ok: true });
  enabledProviders.mockReset().mockReturnValue(["vercel"]);
});
afterEach(() => vi.restoreAllMocks());

describe("POST Vercel sandbox target lookup", () => {
  it.each([401, 403, 404])(
    "does not contact Vercel if workspace access returns %s",
    async (status) => {
      const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected call"));
      requireAccess.mockResolvedValue({ ok: false, status, error: "Access denied" });

      expect((await send({ token: syntheticToken })).status).toBe(status);
      expect(requireAccess).toHaveBeenCalledWith("workspace-1", { requireManager: true });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("does not use provider listing when disabled or input is empty", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("unexpected call"));
    expect((await send({ token: "" })).status).toBe(400);
    enabledProviders.mockReturnValue(["daytona"]);
    expect((await send({ token: syntheticToken })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("uses the supplied token, pages teams, and returns only named choices", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          pagination: { next: 1000 },
          teams: [{ id: "team_a", name: "Acme", slug: "acme", membership: { admin: true } }],
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          pagination: { next: null },
          teams: [{ id: "team_b", name: "Northwind", slug: "northwind" }],
        }),
      );

    const result = await send({ token: syntheticToken });
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(await result.json()).toEqual({
      teams: [
        { id: "team_a", name: "Acme", slug: "acme" },
        { id: "team_b", name: "Northwind", slug: "northwind" },
      ],
    });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.vercel.com/v2/teams?limit=100",
      "https://api.vercel.com/v2/teams?limit=100&until=1000",
    ]);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      headers: { Authorization: `Bearer ${syntheticToken}` },
      redirect: "error",
    });
  });

  it("limits returned project metadata to the requested team", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({
          pagination: { next: "continuation" },
          projects: [
            {
              id: "prj_one",
              name: "Runner",
              accountId: "team_a",
              env: [{ key: "private-config" }],
            },
            { id: "prj_other", name: "Other runner", accountId: "team_b" },
          ],
        }),
      )
      .mockResolvedValueOnce(Response.json({ pagination: { next: null }, projects: [] }));
    const result = await send({ teamId: "team_a", token: syntheticToken });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.vercel.com/v10/projects?limit=100&teamId=team_a",
      "https://api.vercel.com/v10/projects?limit=100&teamId=team_a&from=continuation",
    ]);
    expect(await result.json()).toEqual({ projects: [{ id: "prj_one", name: "Runner" }] });
  });

  it("does not expose provider errors and points restricted tokens to manual entry", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: syntheticToken }, { status: 403 }),
    );
    const result = await send({ token: syntheticToken });
    expect(result.status).toBe(422);
    const body = await result.text();
    expect(body).toContain("enter IDs manually");
    expect(body).not.toContain(syntheticToken);
  });
});
