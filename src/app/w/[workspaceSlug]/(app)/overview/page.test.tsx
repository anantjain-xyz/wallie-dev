// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

import OverviewPage from "./page";

const mocks = vi.hoisted(() => ({
  loadAnalyticsPeriods: vi.fn(),
  loadWorkspaceFactoryOptions: vi.fn(),
  loadAuthenticatedWorkspaceContext: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/features/factory-analytics/analytics-data", () => ({
  loadAnalyticsPeriods: mocks.loadAnalyticsPeriods,
}));
vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.loadWorkspaceFactoryOptions,
}));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocks.loadAuthenticatedWorkspaceContext,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/acme/overview",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

const factory = {
  id: "63700000-0000-4000-8000-000000000002",
  name: "Customer tools",
  isDefault: false,
  status: "active",
} satisfies FactorySelectionOption;
const scope = {
  factory: factory.id,
  from: "2026-10-01",
  to: "2026-11-01",
  compare: "previous",
  dimension: "model",
  environment: "production",
};

async function show(search: Record<string, string | string[]>) {
  const view = await OverviewPage({
    params: Promise.resolve({ workspaceSlug: "acme" }),
    searchParams: Promise.resolve(search),
  });
  return render(<OverlayProvider>{view}</OverlayProvider>);
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.loadWorkspaceFactoryOptions.mockResolvedValue([
    { ...factory, id: "63700000-0000-4000-8000-000000000001", name: "Default", isDefault: true },
    factory,
  ]);
});

afterEach(cleanup);

it.each(["2026-10-01", "2026-09-30", "2028-01-01"])(
  "keeps the factory and entered filters when the end date is %s",
  async (to) => {
    await show({ ...scope, to });

    expect(screen.getByRole("combobox", { name: "Factory" })).toHaveAttribute(
      "data-value",
      factory.id,
    );
    expect(screen.getByLabelText("From date")).toHaveValue(scope.from);
    expect(screen.getByLabelText("To date")).toHaveValue(to);
    expect(screen.getByLabelText("To date")).toHaveAccessibleDescription(
      "Choose an end date 1 to 366 days after the start date.",
    );
    expect(screen.getByLabelText("Deployment environment")).toHaveValue(scope.environment);
    expect(screen.getByRole("checkbox", { name: "Compare with previous period" })).toBeChecked();
    expect(screen.getByRole("link", { name: "Reset Overview filters" })).toHaveAttribute(
      "href",
      `/w/acme/overview?factory=${factory.id}`,
    );
    expect(mocks.loadAnalyticsPeriods).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  },
);

it("shows specific environment guidance and retains valid hidden context on correction", async () => {
  const routingCanary = "63700000-0000-4000-8000-000000000010";
  const routingAlert = "63700000-0000-4000-8000-000000000011";
  await show({ ...scope, environment: "Production", routingCanary, routingAlert });

  const environment = screen.getByLabelText("Deployment environment");
  expect(environment).toHaveValue("Production");
  expect(environment).toHaveAttribute("aria-invalid", "true");
  expect(environment).toHaveAccessibleDescription(/lowercase letters or numbers/);
  expect(screen.getByLabelText("To date")).not.toHaveAttribute("aria-invalid");

  const form = screen.getByRole<HTMLFormElement>("form", { name: "Correct Overview filters" });
  expect(Object.fromEntries(new FormData(form))).toMatchObject({
    ...scope,
    environment: "Production",
    routingCanary,
    routingAlert,
  });
  expect(within(form).queryByText("Break down throughput by")).not.toBeInTheDocument();
});

it("retains malformed date text and lets a user recover from unsupported evidence options", async () => {
  await show({ ...scope, from: "2026-02-30", metric: "throughput", period: "primary" });

  const from = screen.getByLabelText("From date");
  expect(from).toHaveValue("2026-02-30");
  expect(from).toHaveAccessibleDescription(/YYYY-MM-DD/);
  expect(screen.getByText(/options Overview doesn’t support/)).toBeInTheDocument();
  const form = screen.getByRole<HTMLFormElement>("form", { name: "Correct Overview filters" });
  expect(new FormData(form).has("metric")).toBe(false);
  expect(new FormData(form).has("period")).toBe(false);
});

it("does not offer Overview filters or run reads for an unavailable factory", async () => {
  const unavailable = "63700000-0000-4000-8000-000000000003";
  await show({ ...scope, factory: unavailable, environment: "Production" });

  expect(screen.getByRole("heading", { name: "Factory unavailable" })).toBeInTheDocument();
  expect(screen.queryByRole("form")).not.toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Projection health" })).not.toBeInTheDocument();
  expect(mocks.loadAnalyticsPeriods).not.toHaveBeenCalled();
  expect(mocks.rpc).not.toHaveBeenCalled();
});

it("leads with factory and delayed freshness, then shows scoped Analytics and the filters", async () => {
  const unavailable = { status: "unavailable" };
  mocks.loadAuthenticatedWorkspaceContext.mockResolvedValue({
    workspace: { id: "example-id", slug: "acme" },
    supabase: { rpc: mocks.rpc },
  });
  mocks.loadAnalyticsPeriods.mockResolvedValue({
    primary: { flow: unavailable, cost: unavailable, throughput: unavailable, revert: unavailable },
    comparison: null,
  });
  mocks.rpc.mockResolvedValue({
    data: {
      status: "paused",
      canManage: false,
      paused: true,
      pausedAt: null,
      oldestPendingAt: null,
      lagSeconds: null,
      lastAttemptAt: null,
      lastSuccessAt: null,
      sourceSnapshotAt: null,
      failedAt: null,
      retryAfter: null,
      failedAttempts: 0,
      rebuild: { state: "idle", requestedAt: null, completedAt: null },
      evaluatedAt: "2026-11-02T00:00:00Z",
    },
  });

  await show(scope);

  const pageTitle = screen.getByRole("heading", { name: "Overview" });
  const header = within(pageTitle.closest("header")!);
  expect(header.getByText(factory.name, { selector: "span.font-medium" })).toBeVisible();
  expect(header.getByText(/Flow and delivery data is delayed/)).toHaveTextContent(
    "Sessions and outcome capture continue.",
  );
  expect(header.getByRole("link", { name: "Open Inbox" })).toHaveAttribute(
    "href",
    `/w/acme/inbox?factory=${factory.id}`,
  );
  expect(header.queryByRole("link", { name: "Open Analytics" })).not.toBeInTheDocument();
  const summary = screen.getByRole("region", { name: "Analytics summary" });
  const analytics = `/w/acme/analytics?${new URLSearchParams(scope)}`;
  expect(within(summary).getByRole("link", { name: "Open Analytics" })).toHaveAttribute(
    "href",
    analytics,
  );
  expect(within(summary).getByRole("link", { name: "See throughput breakdown" })).toHaveAttribute(
    "href",
    `${analytics}#throughput-title`,
  );
  expect(within(summary).getByRole("link", { name: "Edit filters" })).toHaveAttribute(
    "href",
    "#overview-filters",
  );
  const filters = screen.getByRole("form", { name: "Overview filters" });
  expect(Object.fromEntries(new FormData(filters as HTMLFormElement))).toMatchObject(scope);
  expect(summary.compareDocumentPosition(filters) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const health = screen.getByRole("region", { name: "Projection health" });
  expect(health.querySelector("details")).not.toHaveAttribute("open");
  expect(
    within(health).queryByRole("button", { name: "Resume projection" }),
  ).not.toBeInTheDocument();
  expect(within(health).getByText("Projection snapshot")).not.toBeVisible();
});
