import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  getGroupedWorkspaceNavigation,
  WorkspaceGroupTabs,
} from "@/components/app-shell/grouped-workspace-navigation";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const mobile = {
  id: "mobile",
  name: "Mobile app",
  isDefault: false,
  status: "active",
  canManage: true,
} satisfies FactorySelectionOption;

const nav = (partial: Partial<Parameters<typeof getGroupedWorkspaceNavigation>[0]> = {}) =>
  getGroupedWorkspaceNavigation({
    canManageDefinition: true,
    factories: [mobile],
    pathname: "/w/tandem",
    scope: { kind: "factory", factory: mobile },
    workspaceSlug: "tandem",
    ...partial,
  });

describe("grouped workspace navigation", () => {
  it("has six destinations and leaves Settings global", () => {
    expect(nav().sidebar.map(({ label }) => label)).toEqual([
      "Inbox",
      "Sessions",
      "Activity",
      "Insights",
      "Factory",
      "Settings",
    ]);
    expect(nav().sidebar.map(({ href }) => href)).toEqual([
      "/w/tandem/inbox?factory=mobile",
      "/w/tandem?factory=mobile",
      "/w/tandem/runs?factory=mobile",
      "/w/tandem/analytics?factory=mobile",
      "/w/tandem/settings/factory-definition?factory=mobile",
      "/w/tandem/settings",
    ]);
  });

  it("preserves current Activity and Insights tabs on their existing URLs", () => {
    const feed = nav({ pathname: "/w/tandem/activity", scope: { kind: "all" } });
    expect(feed.activeItem?.id).toBe("activity");
    expect(feed.tabs).toEqual([
      { active: false, href: "/w/tandem/runs?factory=all", label: "Runs" },
      { active: true, href: "/w/tandem/activity?factory=all", label: "Feed" },
    ]);
    const improvement = nav({ pathname: "/w/tandem/improvements/proposal" });
    expect(improvement.activeItem?.id).toBe("insights");
    expect(improvement.tabs.filter(({ active }) => active).map(({ label }) => label)).toEqual([
      "Failures",
    ]);
    expect(improvement.sections.filter(({ active }) => active)).toEqual([
      { active: true, href: "/w/tandem/improvements?factory=mobile", label: "Improvements" },
    ]);
    const markup = renderToStaticMarkup(<WorkspaceGroupTabs label="Insights" {...improvement} />);
    expect(markup).toContain('aria-label="Insights views"');
    expect(markup).toContain('aria-label="Insights sections"');
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(2);
  });

  it("recognizes Inbox as the origin of a review without carrying the inbox filter as the resource owner", () => {
    const review = nav({
      pathname: "/w/tandem/sessions/112",
      returnTo: "/w/tandem/inbox?factory=all",
    });
    expect(review.activeItem?.href).toBe("/w/tandem/inbox?factory=all");
    expect(review.sidebar.find(({ id }) => id === "sessions")?.href).toBe(
      "/w/tandem/sessions?factory=mobile",
    );
    expect(
      nav({ pathname: "/w/tandem/sessions/112", returnTo: "/w/other/inbox" }).activeItem?.id,
    ).toBe("sessions");
  });

  it("offers one ordered row of real links to the same resolved factory", () => {
    const factory = nav({ pathname: "/w/tandem/settings/factory-definition" });
    expect(factory.sections).toEqual([]);
    expect(factory.tabs).toEqual(
      [
        ["Pipeline", "settings/factory-definition"],
        ["Graph workflows", "workflows"],
        ["Agents", "agents"],
        ["Context", "context"],
        ["Memory", "memory"],
        ["Scorers", "scorers"],
        ["Automations", "settings/automations"],
        ["Access", "governance"],
      ].map(([label, path]) => ({
        active: label === "Pipeline",
        label,
        href: `/w/tandem/${path}?factory=mobile`,
      })),
    );
    const markup = renderToStaticMarkup(
      <WorkspaceGroupTabs label="Factory" singleRow {...factory} />,
    );
    expect(markup.match(/<nav /gu)).toHaveLength(1);
    expect(markup.match(/aria-current="page"/gu)).toHaveLength(1);
    expect(markup).not.toMatch(/>Configuration<|>Knowledge<|>Definition</u);
  });

  it.each([
    ["settings/factory-definition", "Pipeline"],
    ["workflows/workflow-1", "Graph workflows"],
    ["agents/agent-1", "Agents"],
    ["context", "Context"],
    ["memory", "Memory"],
    ["scorers/scorer-1", "Scorers"],
    ["settings/automations", "Automations"],
    ["governance", "Access"],
  ])("marks one current item by route for %s", (path, label) => {
    const { tabs } = nav({ pathname: `/w/tandem/${path}` });
    expect(tabs.filter(({ active }) => active).map((item) => item.label)).toEqual([label]);
  });

  it("keeps Pipeline operator-only and preserves the other management gates", () => {
    const reader = { ...mobile, canManage: false };
    const retired = { ...mobile, status: "archived" as const };
    const labels = (
      factories: FactorySelectionOption[],
      canManageDefinition: boolean,
      factory = factories[0],
    ) =>
      nav({
        pathname: "/w/tandem/agents",
        canManageDefinition,
        factories,
        scope: { kind: "factory", factory },
      }).tabs.map(({ label }) => label);
    expect(labels([reader], false)).toEqual(["Agents", "Scorers"]);
    expect(labels([retired], true)).toEqual(["Agents", "Context", "Memory", "Scorers", "Access"]);
    expect(labels([mobile], false)).toEqual([
      "Graph workflows",
      "Agents",
      "Context",
      "Memory",
      "Scorers",
      "Automations",
      "Access",
    ]);
  });

  it.each([
    ["global", "all"],
    ["resource-pending", "all"],
    ["pick", "all"],
    ["unavailable", "unavailable"],
  ] as const)("never opens Default when Factory scope is %s", (kind, request) => {
    const { activeItem, tabs } = nav({
      pathname: "/w/tandem/settings/factory-definition",
      scope: { kind },
    });
    expect(activeItem?.href).toBe(`/w/tandem/settings/factory-definition?factory=${request}`);
    expect(tabs).toContainEqual({
      active: true,
      href: `/w/tandem/settings/factory-definition?factory=${request}`,
      label: "Pipeline",
    });
    expect(tabs.every(({ href }) => href.endsWith(`?factory=${request}`))).toBe(true);
  });
});
