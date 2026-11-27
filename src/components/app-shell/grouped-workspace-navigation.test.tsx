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

  it("offers the exact serial editor only to an operator with active factory scope", () => {
    const settings = nav({
      hash: "#definition-field-stages",
      pathname: "/w/tandem/settings/factory-definition",
    });
    expect(settings.sections).toContainEqual({
      active: true,
      href: "/w/tandem/settings/factory-definition?factory=mobile#definition-field-stages",
      label: "Pipeline",
    });
    expect(settings.sections).toContainEqual({
      active: false,
      href: "/w/tandem/workflows?factory=mobile",
      label: "Graph workflows",
    });
    expect(
      nav({ pathname: "/w/tandem/agents", canManageDefinition: false }).sections.some(
        ({ label }) => label === "Pipeline",
      ),
    ).toBe(false);
    expect(
      nav({
        pathname: "/w/tandem/settings/factory-definition",
        scope: { kind: "pick" },
      }).sections.some(({ label }) => label === "Pipeline"),
    ).toBe(false);
  });
});
