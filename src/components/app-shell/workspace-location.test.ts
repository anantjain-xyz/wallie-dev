import { describe, expect, it } from "vitest";

import {
  matchWorkspaceLocation,
  resolveWorkspaceScopeHint,
  resolveWorkspaceScope,
  restoreWorkspaceScope,
  workspaceLocationForRoute,
  workspaceScopeHref,
  workspaceScopePreference,
  workspaceScopePreferenceKey,
  type WorkspaceRoute,
} from "./workspace-location";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const slug = "tandem";
const platform = {
  id: "a111c1ae-9dcf-4f8d-8b45-eb537dbe782a",
  name: "Platform",
  isDefault: true,
  status: "active",
  canManage: true,
} satisfies FactorySelectionOption;
const mobile = {
  id: "029d7bb8-d497-4ad1-b085-d3264e568faf",
  name: "Mobile app",
  isDefault: false,
  status: "active",
  canManage: false,
} satisfies FactorySelectionOption;
const archived = {
  id: "b2aebcbd-9c7a-44ab-a434-1d27d21d0717",
  name: "Retired lab",
  isDefault: false,
  status: "archived",
  canManage: true,
} satisfies FactorySelectionOption;
const forbidden = "c154106c-75b2-47ea-bc76-9127fa38d5c7";
const factories = [platform, mobile, archived];
const chosen = (factory: FactorySelectionOption) => ({ kind: "factory" as const, factory });
const browse = (
  route: WorkspaceRoute,
  query?: string | readonly string[],
  options: FactorySelectionOption[] = factories,
) => resolveWorkspaceScope(workspaceLocationForRoute(route, slug), options, query);

describe("workspace location contract", () => {
  it.each([
    ["", "sessions", "Board", false],
    ["/sessions/112", "sessions", "List", true],
    ["/runs", "runs", undefined, false],
    ["/runs/run", "runs", undefined, true],
    ["/analytics", "insights", "Analytics", false],
    ["/improvements/proposal", "insights", "Failures", true],
    ["/benchmarks/suite/comparisons/comparison/trials/trial", "insights", "Benchmarks", true],
    ["/settings/factory-definition", "factory", undefined, false],
    ["/settings/automations", "factory", undefined, false],
    ["/context", "factory", undefined, false],
    ["/memory", "factory", undefined, false],
    ["/settings", "settings", undefined, false],
  ])("keeps the legacy address %s in its new section", (suffix, destination, tab, detail) => {
    expect(matchWorkspaceLocation(`/w/${slug}${suffix}`, slug)).toMatchObject({
      destination,
      detail,
    });
    expect(matchWorkspaceLocation(`/w/${slug}${suffix}`, slug)?.tab).toBe(tab);
  });

  it("does not resolve retired Activity routes as scoped views", () => {
    expect(matchWorkspaceLocation(`/w/${slug}/activity`, slug)).toBeUndefined();
    expect(matchWorkspaceLocation(`/w/${slug}/activity/actors`, slug)).toBeUndefined();
  });

  it("does not interpret neighboring workspaces, onboarding, or prefix collisions as scoped views", () => {
    expect(matchWorkspaceLocation("/w/tandem-old/sessions", slug)).toBeUndefined();
    expect(matchWorkspaceLocation("/w/tandem/onboarding", slug)).toBeUndefined();
    expect(matchWorkspaceLocation("/w/tandem/activity-history", slug)).toBeUndefined();
  });

  it("preserves a valid explicit factory in every URL, regardless of what was remembered", () => {
    expect(browse("inbox", mobile.id.toUpperCase())).toEqual(chosen(mobile));
    const opened = new URL(
      workspaceScopeHref("inbox", slug, browse("sessions", mobile.id)),
      "http://localhost",
    );
    expect(opened.pathname).toBe("/w/tandem/inbox");
    expect(opened.search).toBe(`?factory=${mobile.id}`);
    expect(browse("inbox", opened.searchParams.get("factory")!)).toEqual(chosen(mobile));
    expect(browse("inbox", platform.id)).toEqual(chosen(platform));
    expect(restoreWorkspaceScope(mobile.id, factories)).toEqual(chosen(mobile));
  });

  it("never interprets repeated, empty, other-workspace, or forbidden IDs as a fallback", () => {
    for (const value of [forbidden, "", [mobile.id, platform.id], ["all", "all"]]) {
      expect(browse("board", value)).toEqual({ kind: "unavailable" });
    }
    expect(workspaceScopeHref("analytics", slug, browse("board", forbidden))).toBe(
      "/w/tandem/analytics?factory=unavailable",
    );
    expect(workspaceScopeHref("inbox", slug, browse("board", forbidden))).toBe(
      "/w/tandem/inbox?factory=unavailable",
    );
    expect(workspaceScopeHref("runs", slug, browse("sessions", [mobile.id, forbidden]))).toBe(
      "/w/tandem/runs?factory=unavailable",
    );
  });

  it("supports All only on Inbox, Sessions and Runs lists", () => {
    for (const route of ["inbox", "board", "sessions", "runs"] as const) {
      expect(browse(route, "all")).toEqual({ kind: "all" });
    }
    for (const route of [
      "analytics",
      "failures",
      "benchmarks",
      "definition",
      "agents",
      "context",
    ] as const) {
      expect(browse(route, "all")).toEqual({ kind: "pick" });
      expect(browse(route)).toEqual({ kind: "pick" });
    }
    expect(workspaceScopeHref("analytics", slug, browse("inbox", "all"))).toBe(
      "/w/tandem/analytics?factory=all",
    );
    expect(workspaceScopeHref("runs", slug, browse("analytics", "all"))).toBe(
      "/w/tandem/runs?factory=all",
    );
  });

  it("keeps the Board landing and legacy unqualified aggregate semantics without guessing among factories", () => {
    expect(browse("board")).toEqual(chosen(platform));
    expect(browse("sessions")).toEqual(chosen(platform));
    expect(browse("runs")).toEqual(chosen(platform));
    expect(browse("inbox")).toEqual({ kind: "all" });
    expect(workspaceScopeHref("board", slug, browse("inbox"))).toBe("/w/tandem?factory=all");
    expect(workspaceScopeHref("inbox", slug, browse("sessions"))).toBe(
      `/w/tandem/inbox?factory=${platform.id}`,
    );
    const noDefault = [mobile, { ...platform, isDefault: false }];
    expect(browse("sessions", undefined, noDefault)).toEqual(chosen(mobile));
    expect(browse("board", undefined, noDefault)).toEqual({
      kind: "all",
    });
  });

  it("resolves the sole active accessible factory without requiring a default flag", () => {
    for (const route of ["inbox", "sessions", "runs", "analytics", "agents"] as const) {
      expect(browse(route, undefined, [mobile])).toEqual(chosen(mobile));
    }
    expect(browse("analytics", "all", [mobile])).toEqual({ kind: "pick" });
    expect(browse("analytics", undefined, [])).toEqual({ kind: "pick" });
  });

  it("never moves a user from an explicit factory to some other factory with management access", () => {
    for (const route of ["automations", "workflows"] as const) {
      expect(browse(route, mobile.id)).toEqual({ kind: "unavailable" });
      expect(browse(route, archived.id)).toEqual({ kind: "unavailable" });
      expect(browse(route)).toEqual({ kind: "pick" });
      expect(browse(route, platform.id)).toEqual(chosen(platform));
    }
    expect(browse("definition", archived.id)).toEqual({ kind: "unavailable" });
  });

  it("keeps managed factory selection on Governance, Context and Memory", () => {
    for (const route of ["governance", "context", "memory"] as const) {
      expect(browse(route, mobile.id)).toEqual({ kind: "unavailable" });
      expect(browse(route, archived.id)).toEqual(chosen(archived));
    }
    expect(browse("agents", mobile.id)).toEqual(chosen(mobile));
  });

  it("leaves Settings global and restores only active allowed choices within the same account and workspace", () => {
    expect(browse("settings", mobile.id)).toEqual({ kind: "global" });
    expect(workspaceScopeHref("settings", slug, chosen(mobile))).toBe("/w/tandem/settings");
    expect(workspaceScopePreferenceKey("viewer", "workspace")).not.toBe(
      workspaceScopePreferenceKey("viewer", "other-workspace"),
    );
    expect(workspaceScopePreferenceKey("viewer", "workspace")).not.toBe(
      workspaceScopePreferenceKey("other-viewer", "workspace"),
    );
    expect(restoreWorkspaceScope(mobile.id, [platform])).toEqual({ kind: "global" });
    expect(restoreWorkspaceScope(archived.id, factories)).toEqual({ kind: "global" });
    expect(restoreWorkspaceScope("all", factories)).toEqual({ kind: "all" });
    expect(workspaceScopePreference(chosen(archived))).toBeNull();
    expect(browse("sessions", archived.id)).toEqual(chosen(archived));
  });

  it("revalidates a remembered link on the server before giving it an explicit factory", () => {
    const route = workspaceLocationForRoute("inbox", slug);
    expect(workspaceScopeHref("inbox", slug, chosen(mobile), true)).toBe(
      `/w/tandem/inbox?lastFactory=${mobile.id}`,
    );
    expect(
      resolveWorkspaceScopeHint(route, { lastFactory: mobile.id, kind: "review" }, factories),
    ).toBe(`/w/tandem/inbox?kind=review&factory=${mobile.id}`);
    for (const value of [archived.id, forbidden, [mobile.id, "all"]]) {
      expect(resolveWorkspaceScopeHint(route, { lastFactory: value }, factories)).toBe(
        "/w/tandem/inbox",
      );
    }
    expect(
      resolveWorkspaceScopeHint(route, { factory: archived.id, lastFactory: mobile.id }, factories),
    ).toBeNull();
    const managed = workspaceLocationForRoute("automations", slug);
    expect(resolveWorkspaceScopeHint(managed, { lastFactory: mobile.id }, factories)).toBe(
      "/w/tandem/settings/automations",
    );
  });

  it("uses the authorized detail resource, never a return filter or remembered factory", () => {
    const location = matchWorkspaceLocation("/w/tandem/sessions/112", slug);
    expect(resolveWorkspaceScope(location, factories, platform.id)).toEqual({
      kind: "resource-pending",
    });
    expect(resolveWorkspaceScope(location, factories, "all", mobile.id)).toEqual(chosen(mobile));
    expect(resolveWorkspaceScope(location, factories, undefined, archived.id)).toEqual(
      chosen(archived),
    );
    expect(resolveWorkspaceScope(location, factories, mobile.id, forbidden)).toEqual({
      kind: "unavailable",
    });
  });
});
