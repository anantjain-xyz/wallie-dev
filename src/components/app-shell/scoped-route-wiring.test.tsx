import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityPage from "@/app/w/[workspaceSlug]/(app)/activity/page";
import InboxPage from "@/app/w/[workspaceSlug]/(app)/inbox/page";
import RunsPage from "@/app/w/[workspaceSlug]/(app)/runs/page";
import { scopeFactoryIndex } from "@/components/app-shell/workspace-factory-page.server";
import { workspaceFactorySwitchHref } from "@/components/app-shell/workspace-location";
import { getGroupedWorkspaceNavigation } from "@/components/app-shell/grouped-workspace-navigation";
import {
  runFromListHref,
  runListReturn,
  parseRunsListQuery,
} from "@/features/wallie/runs-list-state";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const mocks = vi.hoisted(() => ({
  inbox: vi.fn(),
  inboxView: vi.fn(),
  runs: vi.fn(),
  activity: vi.fn(),
  factories: vi.fn(),
}));

vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.factories,
}));
vi.mock("@/features/factories/factory-selector", () => ({ FactorySelector: () => null }));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  loadAuthenticatedWorkspaceContext: () =>
    Promise.resolve({
      currentMember: { id: "member-id" },
      supabase: {},
      user: { id: "viewer-id" },
      workspace: { id: "workspace-id", slug: "tandem" },
    }),
}));
vi.mock("@/lib/factories/inbox", () => ({ loadFactoryInbox: mocks.inbox }));
vi.mock("@/features/factory-inbox/inbox-page", () => ({
  FactoryInboxPage: mocks.inboxView,
  FactoryInboxUnavailable: () => "Factory unavailable",
}));
vi.mock("@/features/wallie/runs-list-data", () => ({ loadRunsListData: mocks.runs }));
vi.mock("@/features/wallie/runs-list", () => ({ RunsList: () => "Runs list" }));
vi.mock("@/features/factory-activity/activity-data", () => ({
  loadFactoryActivityData: mocks.activity,
}));
vi.mock("@/features/factory-activity/activity-actors-data", () => ({
  loadSelectedActivityActor: () => undefined,
}));
vi.mock("@/features/factory-activity/activity-page", () => ({
  FactoryActivityPage: () => "Activity feed",
}));

const slug = "tandem";
const mobile = {
  id: "029d7bb8-d497-4ad1-b085-d3264e568faf",
  name: "Mobile app",
  isDefault: false,
  canManage: true,
  status: "active",
} satisfies FactorySelectionOption;
const platform = {
  id: "a111c1ae-9dcf-4f8d-8b45-eb537dbe782a",
  name: "Platform",
  isDefault: true,
  canManage: true,
  status: "active",
} satisfies FactorySelectionOption;

const props = (query: Record<string, string | string[] | undefined>) => ({
  params: Promise.resolve({ workspaceSlug: slug }),
  searchParams: Promise.resolve(query),
});

describe("workspace scope route wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.factories.mockResolvedValue([platform, mobile]);
    mocks.inbox.mockResolvedValue({});
    mocks.inboxView.mockReturnValue("Inbox");
  });

  it("keeps the real Runs route and feeds only valid catalog fields into its strict parser", async () => {
    const tabs = getGroupedWorkspaceNavigation({
      canManageDefinition: true,
      factories: [platform, mobile],
      pathname: "/w/tandem/activity",
      scope: { kind: "factory", factory: mobile },
      workspaceSlug: slug,
    }).tabs;
    const address = new URL(tabs[0].href, "https://example.test");
    expect(address.pathname).toBe("/w/tandem/runs");
    expect(address.searchParams.has("tab")).toBe(false);
    address.searchParams.set("status", "success");
    address.searchParams.set("limit", "13");
    address.searchParams.set("cursor", "older");
    await RunsPage(props(Object.fromEntries(address.searchParams)));
    const [workspaceSlug, search, factoryId] = mocks.runs.mock.calls[0];
    expect(workspaceSlug).toBe(slug);
    expect(factoryId).toBe(mobile.id);
    const parsed = parseRunsListQuery(search);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    const detail = new URL(
      runFromListHref(slug, platform.id, parsed.data, factoryId),
      "https://example.test",
    );
    const back = runListReturn(slug, detail.searchParams.get("fromRuns") ?? undefined);
    expect(back).toMatchObject({ label: "Back to filtered runs" });
    const backUrl = new URL(back!.href, "https://example.test");
    expect(backUrl.searchParams.get("factory")).toBe(mobile.id);
    expect(backUrl.searchParams.get("status")).toBe("success");
    expect(backUrl.searchParams.get("cursor")).toBe("older");
  });

  it("keeps Inbox All aggregate and scopes explicit reviews without downgrading denied details", async () => {
    await InboxPage(props({ factory: "all", kind: "review", cursor: "opaque" }));
    expect(mocks.inbox).toHaveBeenCalledWith(
      expect.objectContaining({
        factoryId: null,
        kind: "review",
        cursor: "opaque",
      }),
    );
    await InboxPage(props({ factory: mobile.id }));
    expect(mocks.inbox).toHaveBeenLastCalledWith(expect.objectContaining({ factoryId: mobile.id }));
    await InboxPage(props({ factory: [mobile.id, platform.id] }));
    expect(mocks.inbox).toHaveBeenCalledTimes(2);
  });

  it("resets both Activity cursors on a scope change without inventing another filter", async () => {
    const result = await ActivityPage(
      props({ factory: mobile.id, status: "success", actor: platform.id }),
    );
    const snapshot = Array.isArray(result.props.children)
      ? result.props.children[0].props.snapshot
      : undefined;
    expect(mocks.activity).toHaveBeenCalledWith(
      expect.objectContaining({
        query: { factory: mobile.id, status: "success", actor: platform.id },
      }),
    );
    expect(
      workspaceFactorySwitchHref(
        "/w/tandem/activity",
        `factory=${mobile.id}&sessionsBefore=older&runsBefore=older&status=success&actor=${platform.id}`,
        "all",
        snapshot.resetParams,
        "#activity-runs",
      ),
    ).toBe(`/w/tandem/activity?factory=all&status=success&actor=${platform.id}#activity-runs`);
  });

  it("does not render a factory-only body until the server has authorized a specific factory", async () => {
    const Body = vi
      .fn<(pageProps: ReturnType<typeof props>) => string>()
      .mockReturnValue("Resolved factory body");
    const Page = scopeFactoryIndex(Body, { route: "analytics", title: "Analytics" });
    const all = renderToStaticMarkup(await Page(props({ factory: "all" })));
    expect(all).toContain("Choose a factory");
    expect(Body).not.toHaveBeenCalled();
    expect(renderToStaticMarkup(await Page(props({ factory: mobile.id })))).toContain(
      "Resolved factory body",
    );
    expect(await Body.mock.calls[0]?.[0]?.searchParams).toEqual({ factory: mobile.id });
  });
});
