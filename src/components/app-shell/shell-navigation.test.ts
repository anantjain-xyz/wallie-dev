import { describe, expect, it } from "vitest";

import {
  readSessionLaunchActivation,
  resolveSessionReturnTo,
  sessionLaunchHref,
  shellFactoryScope,
  shellNavDestination,
} from "@/components/app-shell/shell-navigation";
import { getWorkspaceNavItems, type WorkspaceNavItem } from "@/lib/routes";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";

const slug = "northwind";
const nav = getWorkspaceNavItems(slug, { canManageGovernance: true, canManageWorkflows: true });
const item = (id: WorkspaceNavItem["id"]) => nav.find((entry) => entry.id === id)!;
const primary = { id: "default", name: "Central", isDefault: true, status: "active" } as const;
const secondary = {
  id: "second",
  name: "Maker",
  canManage: true,
  isDefault: false,
  status: "active",
} as const;
const factories = [primary, secondary];

function navigation(
  from: WorkspaceNavItem["id"],
  to: WorkspaceNavItem["id"],
  query: string[],
  options: readonly FactorySelectionOption[] = factories,
) {
  const source = item(from);
  const scope = shellFactoryScope({
    factories: options,
    item: source,
    pathname: source.href,
    query,
    slug,
  });
  return shellNavDestination(item(to), slug, options, scope);
}

describe("navigation factory scope", () => {
  it.each([
    ["inbox", []],
    ["inbox", ["all"]],
    ["runs", ["all"]],
  ] as const)("retains All factories from %s between aggregate destinations", (source, query) => {
    expect(navigation(source, "sessions", [...query]).href).toBe(
      "/w/northwind/sessions?factory=all",
    );
    const sourceItem = item(source);
    const scope = shellFactoryScope({
      factories,
      item: sourceItem,
      pathname: sourceItem.href,
      query: [...query],
      slug,
    });
    expect(
      shellNavDestination({ ...item("sessions"), href: `/w/${slug}` }, slug, factories, scope).href,
    ).toBe("/w/northwind?factory=all");
  });

  it("keeps an implicit default when the destination normally aggregates", () => {
    expect(navigation("sessions", "inbox", []).href).toBe("/w/northwind/inbox?factory=default");
    expect(navigation("sessions", "runs", []).href).toBe("/w/northwind/runs");
  });

  it("names the factory when a destination cannot use the current scope", () => {
    expect(navigation("inbox", "analytics", [])).toEqual({
      href: "/w/northwind/analytics?factory=default",
      scopeNote: "Opens in Central",
    });
    expect(navigation("sessions", "workflows", ["default"])).toEqual({
      href: "/w/northwind/workflows?factory=second",
      scopeNote: "Opens in Maker",
    });
    expect(navigation("analytics", "settings", ["second"])).toEqual({
      href: "/w/northwind/settings",
    });
  });

  it("preserves an unavailable scope instead of broadening or choosing another factory", () => {
    expect(navigation("sessions", "runs", ["hidden"]).href).toBe(
      "/w/northwind/runs?factory=hidden",
    );
    expect(navigation("sessions", "runs", ["default", "hidden"]).href).toBe(
      "/w/northwind/runs?factory=default&factory=hidden",
    );
    expect(navigation("sessions", "inbox", [], [secondary]).href).toBe(
      "/w/northwind/inbox?factory=unavailable",
    );
    expect(navigation("governance", "sessions", ["default"]).href).toBe(
      "/w/northwind/sessions?factory=unavailable",
    );
    expect(navigation("analytics", "sessions", ["all"]).href).toBe(
      "/w/northwind/sessions?factory=unavailable",
    );
  });

  it("does not infer a scope from an unpinned detail URL", () => {
    const scope = shellFactoryScope({
      factories,
      item: item("sessions"),
      pathname: "/w/northwind/sessions/42",
      query: [],
      slug,
    });
    expect(shellNavDestination(item("runs"), slug, factories, scope).href).toBe(
      "/w/northwind/runs",
    );
  });
});

describe("session launcher URL", () => {
  it("passes exactly one activation to confirmation and removes it from cancel destinations", () => {
    const activation = "00000000-0000-4000-8000-000000000001";
    const origin = "/w/northwind/workflows?factory=default&q=release#workflow";
    const link = new URL(
      sessionLaunchHref(slug, primary.id, origin, activation),
      "https://example.com",
    );
    expect(readSessionLaunchActivation(link.searchParams)).toBe(activation);
    expect(resolveSessionReturnTo(link.searchParams.get("returnTo"), slug)).toBe(origin);
    expect(
      resolveSessionReturnTo(`/w/northwind?create=1&workflowActivation=${activation}`, slug),
    ).toBe("/w/northwind");
    link.searchParams.append("workflowActivation", activation);
    expect(readSessionLaunchActivation(link.searchParams)).toBeNull();
    expect(readSessionLaunchActivation(new URLSearchParams("workflowActivation="))).toBeNull();
    expect(readSessionLaunchActivation(new URLSearchParams("workflowActivation=old"))).toBeNull();
    expect(readSessionLaunchActivation(new URLSearchParams("create=1"))).toBeUndefined();
  });

  it("keeps the in-workspace path, repeated filters and anchor but not another launch", () => {
    const origin = "/w/northwind/analytics?factory=second&tag=a&tag=b#reporting-health";
    const link = new URL(sessionLaunchHref(slug, primary.id, origin), "https://example.com");
    expect(link.pathname).toBe("/w/northwind/sessions");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      create: "1",
      factory: primary.id,
      returnTo: origin,
    });
    expect(resolveSessionReturnTo("/w/northwind?create=1&returnTo=/x#inbox", slug)).toBe(
      "/w/northwind#inbox",
    );
  });

  it.each([
    null,
    "/w/northwind-other/sessions",
    "/w/another/sessions",
    "/auth/signout",
    "/w/northwind/../../login",
    "/w/northwind/%2e%2e/another",
    "/w/northwind%2Fother",
    "/w/northwind/%5Cother",
    "https://example.com/w/northwind",
    "//example.com/w/northwind",
    "/\\example.com/w/northwind",
  ])("ignores a non-workspace return target (%s)", (value) => {
    expect(resolveSessionReturnTo(value, slug)).toBeNull();
  });
});
