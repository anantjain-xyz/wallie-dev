import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import SessionsRoutePage from "@/app/w/[workspaceSlug]/(app)/sessions/page";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const mocked = vi.hoisted(() => ({
  context: vi.fn(),
  factories: vi.fn(),
  load: vi.fn(),
  page: vi.fn(),
}));

vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocked.factories,
}));
vi.mock("@/features/factories/factory-selector", () => ({ FactorySelector: () => null }));
vi.mock("@/features/sessions/list/data", () => ({ loadSessionListPageData: mocked.load }));
vi.mock("@/features/sessions/list/sessions-page", () => ({ SessionsPage: mocked.page }));
vi.mock("@/features/workspaces/authenticated-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/workspaces/authenticated-context")>()),
  loadAuthenticatedWorkspaceContext: mocked.context,
}));

const payments: FactorySelectionOption = {
  id: "payments-id",
  isDefault: false,
  name: "Payments",
  status: "active",
};
const defaultFactory: FactorySelectionOption = {
  id: "default-id",
  isDefault: true,
  name: "Default factory",
  status: "active",
};

async function renderRoute(factory?: string | string[]) {
  return renderToStaticMarkup(
    await SessionsRoutePage({
      params: Promise.resolve({ workspaceSlug: "acme" }),
      searchParams: Promise.resolve({ factory, q: "#42" }),
    }),
  );
}

describe("Sessions ledger factory selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.context.mockResolvedValue({
      currentMember: { kind: "human", is_active: true, role: "member" },
    });
    mocked.load.mockResolvedValue({});
    mocked.page.mockImplementation(({ factorySelector }: { factorySelector: ReactNode }) => (
      <>
        {factorySelector}
        <p>Ledger results</p>
      </>
    ));
  });

  it.each(["owner", "admin"])(
    "links a workspace %s to Settings even with one factory",
    async (role) => {
      mocked.context.mockResolvedValue({ currentMember: { kind: "human", is_active: true, role } });
      mocked.factories.mockResolvedValue([defaultFactory]);
      const html = await renderRoute();
      expect(html).toContain(
        'href="/w/acme/settings?category=workspace#factories">Manage factories',
      );
    },
  );

  it("does not show workspace factory management to a factory-only manager", async () => {
    mocked.factories.mockResolvedValue([{ ...payments, canManage: true }]);
    expect(await renderRoute(payments.id)).not.toContain("Manage factories");
  });

  it("prefers an accessible active default and allows the unscoped preferences", async () => {
    mocked.factories.mockResolvedValue([payments, defaultFactory]);
    await renderRoute();
    expect(mocked.load).toHaveBeenCalledWith(
      "acme",
      { factory: undefined, q: "#42" },
      defaultFactory.id,
    );
    expect(mocked.page.mock.calls[0]?.[0]).toMatchObject({
      factoryId: defaultFactory.id,
      factoryQuery: undefined,
      showCreationOnboarding: true,
    });
  });

  it("recovers to the first accessible active factory when the default is inaccessible", async () => {
    mocked.factories.mockResolvedValue([payments, { ...payments, id: "other", name: "Shipping" }]);
    expect(await renderRoute()).toContain("Ledger results");
    expect(mocked.load).toHaveBeenCalledWith(
      "acme",
      { factory: payments.id, q: "#42" },
      payments.id,
    );
    expect(mocked.page.mock.calls[0]?.[0]).toMatchObject({
      factoryName: "Payments",
      factoryQuery: payments.id,
      readOnly: false,
      showCreationOnboarding: false,
    });
  });

  it("uses the read-only authorized aggregate when only archived factories remain", async () => {
    mocked.factories.mockResolvedValue([{ ...defaultFactory, status: "archived" }]);
    await renderRoute();
    expect(mocked.load).toHaveBeenCalledWith("acme", { factory: "all", q: "#42" }, undefined);
    expect(mocked.page.mock.calls[0]?.[0]).toMatchObject({ factoryQuery: "all", readOnly: true });
  });

  it("honors an explicit accessible archived factory", async () => {
    mocked.factories.mockResolvedValue([{ ...payments, status: "archived" }, defaultFactory]);
    await renderRoute("PAYMENTS-ID");
    expect(mocked.load).toHaveBeenCalledWith(
      "acme",
      { factory: payments.id, q: "#42" },
      payments.id,
    );
  });

  it.each([{ factory: "restricted-id" }, { factory: ["payments-id", "restricted-id"] }])(
    "does not widen an inaccessible or ambiguous explicit selection ($factory)",
    async ({ factory }) => {
      mocked.factories.mockResolvedValue([payments]);
      const html = await renderRoute(factory);
      expect(html).toContain("Factory unavailable");
      expect(html).toContain("View accessible sessions");
      expect(html).not.toContain("restricted-id");
      expect(mocked.load).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "all"])(
    "offers no recovery loop without accessible factories (%j)",
    async (factory) => {
      mocked.factories.mockResolvedValue([]);
      const html = await renderRoute(factory);
      expect(html).toContain("Factory unavailable");
      expect(html).toContain("Ask a workspace admin for access.");
      expect(html).not.toContain("View accessible sessions");
      expect(mocked.load).not.toHaveBeenCalled();
    },
  );
});
