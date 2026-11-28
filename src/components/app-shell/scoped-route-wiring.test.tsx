import type { ReactNode } from "react";
import { renderToReadableStream, renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import ActivityPage from "@/app/w/[workspaceSlug]/(app)/activity/page";
import FailureGroupPage from "@/app/w/[workspaceSlug]/(app)/failure-groups/[cohortId]/page";
import FailureValidationPage from "@/app/w/[workspaceSlug]/(app)/failure-groups/[cohortId]/validation/[memberId]/page";
import ImprovementPage from "@/app/w/[workspaceSlug]/(app)/improvements/[proposalId]/page";
import InboxPage from "@/app/w/[workspaceSlug]/(app)/inbox/page";
import RunsPage from "@/app/w/[workspaceSlug]/(app)/runs/page";
import AutomationsPage from "@/app/w/[workspaceSlug]/(app)/settings/automations/page";
import { scopeFactoryIndex } from "@/components/app-shell/workspace-factory-page.server";
import {
  workspaceFactorySwitchHref,
  workspaceScopeLocationKey,
} from "@/components/app-shell/workspace-location";
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
  automationList: vi.fn(),
  automationRead: vi.fn(),
  automationSetup: vi.fn(),
  factories: vi.fn(),
  failureCohort: vi.fn(),
  failureValidation: vi.fn(),
  rpc: vi.fn(),
  scopeHandoff: vi.fn(() => null),
}));

vi.mock("@/components/app-shell/workspace-scope-context", () => ({
  WorkspaceScopeHandoff: mocks.scopeHandoff,
}));
vi.mock("@/features/factories/factory-options-data", () => ({
  loadWorkspaceFactoryOptions: mocks.factories,
}));
vi.mock("@/features/factories/factory-selector", () => ({ FactorySelector: () => null }));
vi.mock("@/features/workspaces/authenticated-context", () => ({
  isWorkspaceOperator: () => false,
  loadAuthenticatedWorkspaceContext: () =>
    Promise.resolve({
      currentMember: { id: "member-id" },
      supabase: { rpc: mocks.rpc },
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
vi.mock("@/lib/factory-automations/service", () => ({
  listFactoryAutomations: mocks.automationList,
  readFactoryAutomation: mocks.automationRead,
  readAutomationAdmissionControl: vi.fn(),
}));
vi.mock("@/lib/factory-automations/operator-data", () => ({
  loadFactoryAutomationSetup: mocks.automationSetup,
  listFactoryAutomationOccurrenceHistory: vi.fn(),
  loadAutomationRepositories: vi.fn(),
  loadAutomationRevisionNames: vi.fn(),
}));
vi.mock("@/lib/factory-failures/cohorts", () => ({ getFailureCohort: mocks.failureCohort }));
vi.mock("@/features/factory-failures/failure-validation-data", () => ({
  loadFailureValidation: mocks.failureValidation,
}));

const slug = "tandem";
const cohortId = "b974a915-abf8-4f96-9f6e-4a0b26b41f35";
const memberId = "a6e68d53-190b-4658-ae99-bced8c09f9fb";
const proposalId = "68b2e7e4-3e1d-4d9d-90af-707473ca284d";
const revisionId = "cab36d7c-8c13-4a42-ae96-54bd161cdc00";
const groupsPath = `/w/${slug}/failure-groups`;
const groupPath = `${groupsPath}/${cohortId}`;
const validationPath = `${groupPath}/validation/${memberId}`;
const improvementsPath = `/w/${slug}/improvements`;
const automationsPath = `/w/${slug}/settings/automations`;
const proposalPath = `${improvementsPath}/${proposalId}`;
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

const groupPage = (query: Parameters<typeof props>[0]) =>
  FailureGroupPage({
    ...props(query),
    params: Promise.resolve({ workspaceSlug: slug, cohortId }),
  });

const proposalPage = (query: Parameters<typeof props>[0]) =>
  ImprovementPage({
    ...props(query),
    params: Promise.resolve({ workspaceSlug: slug, proposalId }),
  });

const evidencePage = (factory: string) =>
  FailureValidationPage({
    params: Promise.resolve({ workspaceSlug: slug, cohortId, memberId }),
    searchParams: Promise.resolve({ factory }),
  });

async function renderPage(page: Promise<ReactNode>) {
  return new Response(await renderToReadableStream(await page)).text();
}

function expectMobileScopeHandoff(pathname: string) {
  expect(mocks.scopeHandoff).toHaveBeenCalledExactlyOnceWith(
    {
      snapshot: expect.objectContaining({
        locationKey: workspaceScopeLocationKey(pathname),
        picker: "locked",
        scope: { kind: "factory", factory: mobile },
      }),
    },
    undefined,
  );
}

describe("workspace scope route wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.factories.mockResolvedValue([platform, mobile]);
    mocks.inbox.mockResolvedValue({});
    mocks.inboxView.mockReturnValue("Inbox");
    mocks.automationList.mockResolvedValue({ automations: [], nextCursor: null });
    mocks.automationRead.mockResolvedValue(null);
    mocks.automationSetup.mockResolvedValue(null);
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

  it("uses the authorized Automations receipt for the list, editor setup, and switch reset", async () => {
    const factory = mobile.id.toUpperCase();
    const result = await AutomationsPage(props({ factory, mode: "new", afterId: cohortId }));
    const receipt = result.props.children[0].props.snapshot;
    expect(receipt).toMatchObject({
      locationKey: workspaceScopeLocationKey(automationsPath, factory),
      picker: "guarded",
      scope: { kind: "factory", factory: mobile },
    });
    const scope = { workspaceId: "workspace-id", factoryId: mobile.id };
    expect(mocks.automationList).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      scope,
      cohortId,
    );
    expect(mocks.automationSetup).toHaveBeenCalledExactlyOnceWith(expect.anything(), scope);
    expect(mocks.automationRead).not.toHaveBeenCalled();
    expect(
      workspaceFactorySwitchHref(
        automationsPath,
        `factory=${factory}&automation=${proposalId}&revision=${revisionId}&mode=new&afterId=${cohortId}&historyBefore=earlier&historyBeforeId=${memberId}&q=keep`,
        platform.id,
        receipt.resetParams,
      ),
    ).toBe(`${automationsPath}?factory=${platform.id}&q=keep`);
  });

  it.each([
    { factory: "", outcome: "Factory unavailable" },
    { factory: "invalid", outcome: "Factory unavailable" },
    { factory: cohortId, outcome: "Factory unavailable" },
    { factory: [platform.id, platform.id], outcome: "Factory unavailable" },
    { factory: mobile.id, outcome: "Factory unavailable" },
    { factory: revisionId, outcome: "Factory unavailable" },
    { factory: "all", outcome: "Choose a factory" },
    { factory: undefined, outcome: "Choose a factory" },
  ])(
    "does not load rules or editor setup for Automations factory $factory",
    async ({ factory, outcome }) => {
      mocks.factories.mockResolvedValue([
        platform,
        { ...mobile, canManage: false },
        { ...mobile, id: revisionId, status: "archived" },
      ]);
      const markup = await renderPage(AutomationsPage(props({ factory, mode: "new" })));
      expect(markup).toContain(outcome);
      expect(markup).not.toContain("New rule");
      expect(mocks.automationList).not.toHaveBeenCalled();
      expect(mocks.automationRead).not.toHaveBeenCalled();
      expect(mocks.automationSetup).not.toHaveBeenCalled();
      expect(mocks.scopeHandoff).toHaveBeenCalledWith(
        { snapshot: expect.objectContaining({ picker: "header" }) },
        undefined,
      );
    },
  );

  it("does not retarget an unavailable automation or offer an editor after a scoped rule miss", async () => {
    await AutomationsPage(
      props({ factory: mobile.id, automation: proposalId, revision: revisionId }),
    );
    expect(mocks.automationRead).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      { workspaceId: "workspace-id", factoryId: mobile.id, automationId: proposalId },
      { revisionId },
    );
    expect(mocks.automationSetup).not.toHaveBeenCalled();
  });

  it.each([
    { name: "group filters", query: { symptom: "unknown" }, retained: "" },
    { name: "revision", query: { revision: "not-a-revision" }, retained: "" },
    {
      name: "evidence filters",
      query: { symptom: "validation", observedOn: "not-a-date" },
      retained: "&amp;symptom=validation",
    },
  ])(
    "locks the failure group to its authorized factory with invalid $name",
    async ({ query, retained }) => {
      const markup = await renderPage(groupPage({ factory: mobile.id.toUpperCase(), ...query }));

      expect(markup).toContain("Failure group unavailable");
      expect(markup).toContain(`href="${groupsPath}?factory=${mobile.id}${retained}"`);
      expect(markup).toContain(`href="${groupPath}?factory=${mobile.id}${retained}"`);
      expect(markup).toContain("Reset group filters");
      expect(mocks.failureCohort).not.toHaveBeenCalled();
      expectMobileScopeHandoff(groupPath);
    },
  );

  it.each([
    { name: "group", revision: undefined },
    { name: "revision", revision: revisionId },
  ])("locks the authorized factory when the failure $name is unavailable", async ({ revision }) => {
    mocks.failureCohort.mockResolvedValue(null);
    const markup = await renderPage(groupPage({ factory: mobile.id, revision }));

    expect(markup).toContain("Failure group unavailable");
    expect(markup).toContain(
      `href="${groupsPath}?factory=${mobile.id}${revision ? `&amp;revision=${revision}` : ""}"`,
    );
    expect(markup).not.toContain("Reset group filters");
    if (revision) {
      expect(markup).toContain(`href="${groupPath}?factory=${mobile.id}"`);
      expect(markup).toContain("Clear revision filter");
    } else {
      expect(markup).not.toContain("Clear revision filter");
    }
    expect(mocks.failureCohort).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      expect.objectContaining({ factoryId: mobile.id }),
      cohortId,
      { revision },
    );
    expectMobileScopeHandoff(groupPath);
  });

  it.each([
    ["revision", { revision: "not-a-revision" }],
    ["discussion cursor", { before: "0" }],
    ["source cohort", { cohort: "not-a-cohort" }],
  ])("locks the proposal to its authorized factory with an invalid %s", async (_, query) => {
    const markup = await renderPage(
      proposalPage({ factory: mobile.id.toUpperCase(), reviewState: "open", ...query }),
    );

    expect(markup).toContain("Proposal revision unavailable");
    expect(markup).toContain(
      `href="${improvementsPath}?factory=${mobile.id}&amp;reviewState=open"`,
    );
    expect(mocks.rpc).not.toHaveBeenCalled();
    expectMobileScopeHandoff(proposalPath);
  });

  it.each([
    { name: "proposal", revision: undefined },
    { name: "revision", revision: revisionId },
  ])(
    "locks the authorized factory when the improvement $name is unavailable",
    async ({ revision }) => {
      mocks.rpc.mockResolvedValue({ data: null, error: null });
      const markup = await renderPage(
        proposalPage({ factory: mobile.id, cohort: cohortId, revision }),
      );

      expect(markup).toContain("Proposal revision unavailable");
      expect(markup).toContain(`href="${improvementsPath}?factory=${mobile.id}"`);
      expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("read_factory_improvement_workbench", {
        p_workspace_id: "workspace-id",
        p_factory_id: mobile.id,
        p_proposal_id: proposalId,
        ...(revision ? { p_revision_id: revision } : {}),
      });
      expectMobileScopeHandoff(proposalPath);
    },
  );

  it.each([
    ["failure group", groupPage],
    ["improvement proposal", proposalPage],
  ])("does not publish scope or read %s details for an unauthorized factory", async (_, page) => {
    const markup = await renderPage(page({ factory: "c10d32cd-7036-48f8-8c05-d7aa38f473c5" }));

    expect(markup).toContain("Factory unavailable");
    expect(markup).toContain(`href="/w/${slug}/sessions?factory=all"`);
    expect(mocks.failureCohort).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.scopeHandoff).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", "Evidence unavailable"],
    ["unavailable", "Evidence unavailable"],
    ["withheld", "Evidence withheld"],
  ])("keeps the authorized factory when validation evidence is %s", async (state, heading) => {
    const member = { id: memberId };
    mocks.failureCohort.mockResolvedValue(state === "missing" ? null : { members: [member] });
    mocks.failureValidation.mockResolvedValue({ state, evidence: null });

    const markup = await new Response(
      await renderToReadableStream(await evidencePage(mobile.id.toUpperCase())),
    ).text();

    expect(markup).toContain(heading);
    expect(markup).toContain(`href="${groupPath}?factory=${mobile.id}"`);
    expect(markup).not.toContain("View technical receipt");
    expect(mocks.failureCohort).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ factoryId: mobile.id }),
      cohortId,
      { memberId, revision: undefined },
    );
    if (state === "missing") expect(mocks.failureValidation).not.toHaveBeenCalled();
    expect(mocks.scopeHandoff).toHaveBeenCalledExactlyOnceWith(
      {
        snapshot: expect.objectContaining({
          locationKey: workspaceScopeLocationKey(validationPath),
          picker: "locked",
          scope: { kind: "factory", factory: mobile },
        }),
      },
      undefined,
    );
  });

  it("does not claim a factory or read evidence when the requested factory is not authorized", async () => {
    const markup = await new Response(
      await renderToReadableStream(await evidencePage("c10d32cd-7036-48f8-8c05-d7aa38f473c5")),
    ).text();

    expect(markup).toContain("Evidence unavailable");
    expect(markup).toContain(`href="${groupPath}"`);
    expect(mocks.failureCohort).not.toHaveBeenCalled();
    expect(mocks.failureValidation).not.toHaveBeenCalled();
    expect(mocks.scopeHandoff).toHaveBeenCalledExactlyOnceWith(
      { snapshot: expect.objectContaining({ scope: { kind: "unavailable" } }) },
      undefined,
    );
  });
});
