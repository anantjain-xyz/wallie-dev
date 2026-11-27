import { expect, it } from "vitest";

import { GET } from "./route";

const workspace = "/w/acme";
const factory = "63700000-0000-4000-8000-000000000002";
const canary = "63700000-0000-4000-8000-000000000010";
const alert = "63700000-0000-4000-8000-000000000011";
const dates = { from: "2026-10-01", to: "2026-11-01" };

async function redirect(search: string | URLSearchParams) {
  const response = await GET(new Request(`http://localhost${workspace}/overview?${search}`), {
    params: Promise.resolve({ workspaceSlug: "acme" }),
  });
  expect(response.status).toBe(307);
  expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  const location = response.headers.get("Location");
  if (!location) throw new Error("Expected an Analytics redirect");
  const url = new URL(location, "http://localhost");
  expect(url.pathname).toBe(`${workspace}/analytics`);
  expect(url.hash).toBe("");
  return url.searchParams;
}

it("preserves compatible filters without inventing a factory or dates", async () => {
  const scope = {
    factory,
    ...dates,
    compare: "previous",
    dimension: "model",
    environment: "production",
    routingCanary: canary,
    routingAlert: alert,
  };
  const search = await redirect(
    new URLSearchParams({ ...scope, next: "/w/elsewhere", create: "1", scorerRevision: alert }),
  );
  expect(Object.fromEntries(search)).toEqual(scope);
  expect([...(await redirect(""))]).toEqual([]);
});

it.each(["", "all", "not-an-id", `${factory}&factory=${factory}`])(
  "does not recover an explicit factory of %s to the default",
  async (request) => {
    expect(
      Object.fromEntries(await redirect(`factory=${request}&from=${dates.from}&to=${dates.to}`)),
    ).toEqual({
      factory: "unavailable",
      ...dates,
    });
  },
);

it.each(["2026-10-01", "2026-09-30", "2028-01-01", "", "2026-02-30"])(
  "preserves the selected factory and requires recovery for an incompatible range ending %s",
  async (to) => {
    const result = await redirect(
      new URLSearchParams({ factory, ...dates, to, compare: "previous", dimension: "model" }),
    );
    expect(Object.fromEntries(result)).toEqual({
      factory,
      dimension: "model",
      overviewFilters: "invalid",
    });
  },
);

it("requires explicit recovery without enabling Analytics-only evidence or copying malformed fields", async () => {
  const result = await redirect(
    new URLSearchParams({
      factory,
      ...dates,
      compare: "last",
      environment: "Production",
      metric: "throughput",
      period: "primary",
      routingCanary: canary,
      routingAlert: "not-an-id",
    }),
  );
  expect(Object.fromEntries(result)).toEqual({
    factory,
    ...dates,
    routingCanary: canary,
    overviewFilters: "invalid",
  });
});
