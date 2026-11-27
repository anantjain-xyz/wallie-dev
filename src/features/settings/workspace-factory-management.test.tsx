import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Database } from "@/lib/supabase/database.types";

import {
  WorkspaceFactoryManagement,
  type FactoryManagementMember,
} from "./workspace-factory-management";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  options: vi.fn(),
  panel: vi.fn<(props: { members: FactoryManagementMember[] }) => null>(() => null),
}));

vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: mocks.context,
}));
vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.options,
}));
vi.mock("@/features/settings/islands/factory-management-island", () => ({
  FactoryManagementCloseLink: () => <a href="#factories">Close</a>,
  WorkspaceFactoryManagementIsland: mocks.panel,
}));
vi.mock("@/features/settings/workspace-settings-load-error", () => ({
  WorkspaceSettingsLoadError: ({ label }: { label: string }) => (
    <p role="alert">Could not load {label}.</p>
  ),
}));

const factory = { id: "factory-1", name: "Payments Lab", canManage: true };
const memberId = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const workspaceMembers = Array.from({ length: 1002 }, (_, index) => ({
  id: memberId(index),
  full_name: `Fixture member ${index}`,
  email: null,
  role: "member",
}));
const factoryGrants = workspaceMembers.slice(0, -1).map(({ id }, index) => ({
  member_id: id,
  role: index === 1000 ? "manager" : "member",
}));

function mockMembershipReads(failLaterPage?: "factory_members" | "workspace_members") {
  const fetch = vi.fn((input: RequestInfo | URL) => {
    const { pathname, searchParams } = new URL(String(input));
    const table = pathname.split("/").at(-1);
    const grants = table === "factory_members";
    const key = grants ? "member_id" : "id";
    const after = searchParams.get(key)?.slice(3);
    const limit = Math.min(1000, Number(searchParams.get("limit") ?? 1000));
    expect(table).toBe(grants ? "factory_members" : "workspace_members");
    expect(searchParams.get("workspace_id")).toBe("eq.workspace-1");
    expect(searchParams.get("order")).toBe(`${key}.asc`);
    if (grants) {
      expect(searchParams.get("factory_id")).toBe(`eq.${factory.id}`);
      expect(searchParams.get("revoked_at")).toBe("is.null");
    } else {
      expect(searchParams.get("kind")).toBe("eq.human");
      expect(searchParams.get("is_active")).toBe("eq.true");
    }
    if (after && table === failLaterPage) {
      return Promise.resolve(Response.json({ message: "Read failed." }, { status: 503 }));
    }
    const page = grants
      ? factoryGrants.filter((row) => !after || row.member_id > after)
      : workspaceMembers.filter((row) => !after || row.id > after);
    return Promise.resolve(Response.json(page.slice(0, limit)));
  });
  const supabase = createClient<Database>("https://supabase.example.test", "fixture-key", {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch },
  });
  mocks.context.mockResolvedValue({ workspace: { id: "workspace-1" }, supabase });
  return fetch;
}

async function renderManagement() {
  return renderToStaticMarkup(
    await WorkspaceFactoryManagement({ workspaceSlug: "northwind", factoryId: factory.id }),
  );
}

describe("factory management membership reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.options.mockResolvedValue([factory]);
  });

  it("joins active grants and workspace members past the PostgREST row limit", async () => {
    mockMembershipReads();
    await renderManagement();
    const members = mocks.panel.mock.lastCall?.[0].members;
    expect(members).toHaveLength(1002);
    expect(members?.filter(({ factoryRole }) => factoryRole !== null)).toHaveLength(1001);
    expect(members?.find(({ id }) => id === memberId(1000))?.factoryRole).toBe("manager");
    expect(members?.find(({ id }) => id === memberId(1001))?.factoryRole).toBeNull();
  });

  it.each(["factory_members", "workspace_members"] as const)(
    "does not render an incomplete membership editor if a later %s page fails",
    async (table) => {
      mockMembershipReads(table);
      const html = await renderManagement();
      expect(html).toContain("Could not load factory management.");
      expect(html).toContain("Close");
      expect(mocks.panel).not.toHaveBeenCalled();
    },
  );

  it("does not read the roster when the selected factory is not manageable", async () => {
    const fetch = mockMembershipReads();
    mocks.options.mockResolvedValue([{ ...factory, canManage: false }]);
    const html = await renderManagement();
    expect(html).toContain("Factory management unavailable");
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.panel).not.toHaveBeenCalled();
  });
});
