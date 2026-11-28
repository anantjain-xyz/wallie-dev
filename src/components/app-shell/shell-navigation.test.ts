import { describe, expect, it } from "vitest";

import {
  readSessionLaunchActivation,
  resolveSessionReturnTo,
  sessionLaunchHref,
} from "@/components/app-shell/shell-navigation";

const slug = "northwind";
const factoryId = "default";

describe("session launcher URL", () => {
  it("passes exactly one activation to confirmation and removes it from cancel destinations", () => {
    const activation = "00000000-0000-4000-8000-000000000001";
    const origin = "/w/northwind/workflows?factory=default&q=release#workflow";
    const link = new URL(
      sessionLaunchHref(slug, factoryId, origin, activation),
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
    const link = new URL(sessionLaunchHref(slug, factoryId, origin), "https://example.com");
    expect(link.pathname).toBe("/w/northwind/sessions");
    expect(Object.fromEntries(link.searchParams)).toEqual({
      create: "1",
      factory: factoryId,
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
