import { Suspense } from "react";
import { beforeEach, expect, it, vi } from "vitest";

import AnalyticsPage from "./page";

const mocks = vi.hoisted(() => ({
  options: vi.fn(),
  context: vi.fn(),
  periods: vi.fn(),
  environments: vi.fn(),
  evidence: vi.fn(),
  routingCanary: vi.fn(),
}));

vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.options,
}));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocks.context,
  isWorkspaceOperator: () => true,
}));
vi.mock("@/features/factory-analytics/analytics-data", () => ({
  loadAnalyticsPeriods: mocks.periods,
  loadDeploymentEnvironments: mocks.environments,
  loadAnalyticsEvidence: mocks.evidence,
}));
vi.mock("@/features/factory-analytics/routing-canary-data", () => ({
  loadRoutingCanaryComparison: mocks.routingCanary,
}));

const factoryId = "63700000-0000-4000-8000-000000000002";
const supabase = { rpc: vi.fn() };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.options.mockResolvedValue([
    { id: factoryId, name: "Reporting factory", status: "active", canManage: true },
  ]);
  mocks.context.mockResolvedValue({ workspace: { id: "workspace", slug: "example" }, supabase });
});

function open(factory: string) {
  return AnalyticsPage({
    params: Promise.resolve({ workspaceSlug: "example" }),
    searchParams: Promise.resolve({ factory, from: "2026-11-01", to: "2026-11-08" }),
  });
}

it("starts one scoped outcome read without awaiting it or optional details before rendering health", async () => {
  const periods = new Promise(() => {});
  mocks.periods.mockReturnValue(periods);
  mocks.environments.mockReturnValue(new Promise(() => {}));

  const page = await open(factoryId);

  expect(mocks.periods).toHaveBeenCalledExactlyOnceWith({
    supabase,
    workspaceId: "workspace",
    factoryId,
    query: expect.objectContaining({
      from: "2026-11-01T00:00:00.000Z",
      to: "2026-11-08T00:00:00.000Z",
    }),
  });
  expect(page.props.periods).toBe(periods);
  expect(page.props.reportingHealth.type).toBe(Suspense);
  expect(page.props.details.type).toBe(Suspense);
  expect(page.props.details.props.children.props.periodsRead).toBe(periods);
  expect(mocks.evidence).not.toHaveBeenCalled();
  expect(mocks.routingCanary).not.toHaveBeenCalled();
  expect(supabase.rpc).not.toHaveBeenCalled();
});

it.each(["all", "63700000-0000-4000-8000-000000000003"])(
  "does not start reporting reads for an unavailable scope %s",
  async (factory) => {
    await open(factory);
    expect(mocks.periods).not.toHaveBeenCalled();
    expect(mocks.environments).not.toHaveBeenCalled();
    expect(supabase.rpc).not.toHaveBeenCalled();
  },
);
