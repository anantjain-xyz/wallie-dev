import { describe, expect, it } from "vitest";

import {
  defaultsToAllFactories,
  factorySwitchHref,
  isFactoryAggregatePath,
  isFactorySelectorPath,
  resolveFactorySelection,
  resolveGovernanceFactorySelection,
  withFactoryQuery,
  type FactorySelectionOption,
} from "@/features/factories/factory-selection";

const factory = {
  id: "default-id",
  isDefault: true,
  name: "Default factory",
  status: "active",
} satisfies FactorySelectionOption;
const secondary = {
  id: "secondary-id",
  isDefault: false,
  name: "Payments",
  status: "archived",
} satisfies FactorySelectionOption;

describe("factory scope on aggregate routes", () => {
  it("resolves the authorized default or explicit visible factory", () => {
    const factories = [factory, secondary];
    expect(resolveFactorySelection(factories, undefined)).toEqual({ kind: "factory", factory });
    expect(resolveFactorySelection(factories, secondary.id)).toEqual({
      kind: "factory",
      factory: secondary,
    });
    expect(resolveFactorySelection(factories, "all")).toEqual({ kind: "all" });
  });

  it("does not substitute another scope for an unavailable or ambiguous factory", () => {
    expect(resolveFactorySelection([secondary], undefined)).toEqual({ kind: "unavailable" });
    expect(resolveFactorySelection([secondary], "restricted")).toEqual({ kind: "unavailable" });
    expect(resolveFactorySelection([secondary], ["all", secondary.id])).toEqual({
      kind: "unavailable",
    });
  });

  it("only treats exact list/board destinations as aggregate", () => {
    expect(isFactoryAggregatePath("/w/acme", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/sessions", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/runs", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/activity", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/inbox", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/sessions/42", "acme")).toBe(false);
    expect(isFactoryAggregatePath("/w/acme/runs/c66", "acme")).toBe(false);
    expect(isFactoryAggregatePath("/w/acme/settings", "acme")).toBe(false);
  });

  it("defaults Inbox to every permitted factory and drops a previous cursor when switching", () => {
    expect(defaultsToAllFactories("/w/acme/inbox", "acme")).toBe(true);
    expect(defaultsToAllFactories("/w/acme/sessions", "acme")).toBe(false);
    expect(factorySwitchHref("/w/acme/inbox", "cursor=old", secondary.id)).toBe(
      "/w/acme/inbox?factory=secondary-id",
    );
  });

  it("resets only scope-specific filters and preserves unrelated state", () => {
    const result = factorySwitchHref(
      "/w/acme/sessions",
      "q=auth&sort=oldest&cursor=old&stage=custom&create=1&sessionId=session&stageId=stage",
      secondary.id,
    );
    expect(result).toBe("/w/acme/sessions?q=auth&sort=oldest&factory=secondary-id");
  });

  it("shows a single-factory selector for the Agents list and resets its pagination", () => {
    expect(isFactoryAggregatePath("/w/acme/agents", "acme")).toBe(false);
    expect(isFactorySelectorPath("/w/acme/agents", "acme")).toBe(true);
    expect(isFactorySelectorPath("/w/acme/agents/1", "acme")).toBe(false);
    expect(factorySwitchHref("/w/acme/agents", "after=cursor", secondary.id)).toBe(
      "/w/acme/agents?factory=secondary-id",
    );
  });

  it("offers Governance only for factories the viewer manages and resets resource filters", () => {
    const managed = { ...secondary, canManage: true };
    expect(resolveGovernanceFactorySelection([factory, managed], undefined)).toEqual({
      kind: "factory",
      factory: managed,
    });
    expect(resolveGovernanceFactorySelection([factory, managed], factory.id)).toEqual({
      kind: "unavailable",
    });
    expect(resolveGovernanceFactorySelection([managed], "all")).toEqual({ kind: "unavailable" });
    expect(isFactorySelectorPath("/w/acme/governance", "acme")).toBe(true);
    expect(isFactoryAggregatePath("/w/acme/governance", "acme")).toBe(false);
    expect(
      factorySwitchHref(
        "/w/acme/governance",
        "grant=old&beforeAudit=older&actor=previous",
        managed.id,
      ),
    ).toBe("/w/acme/governance?factory=secondary-id");
  });

  it("carries explicit scope including duplicates without changing other query values", () => {
    expect(withFactoryQuery("/w/acme/runs", null)).toBe("/w/acme/runs");
    expect(withFactoryQuery("/w/acme/sessions?sort=number", ["all", secondary.id])).toBe(
      "/w/acme/sessions?sort=number&factory=all&factory=secondary-id",
    );
  });
});
