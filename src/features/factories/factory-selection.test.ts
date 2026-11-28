import { describe, expect, it } from "vitest";

import {
  factorySwitchHref,
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

describe("factory scope and selection", () => {
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

  it("uses the first accessible factory when the view allows fallback and the default is hidden", () => {
    expect(resolveFactorySelection([secondary], undefined, { useFirstVisible: true })).toEqual({
      kind: "factory",
      factory: secondary,
    });
    expect(resolveFactorySelection([secondary], "restricted", { useFirstVisible: true })).toEqual({
      kind: "unavailable",
    });
  });

  it("drops the Inbox pagination cursor when switching factories", () => {
    expect(factorySwitchHref("/w/acme/inbox", "cursor=old", secondary.id)).toBe(
      "/w/acme/inbox?factory=secondary-id",
    );
  });

  it("resets base scope-specific filters and preserves unrelated state", () => {
    const result = factorySwitchHref(
      "/w/acme/sessions",
      "q=auth&sort=oldest&cursor=old&stage=custom&create=1&returnTo=%2Fw%2Facme&sessionId=session&stageId=stage&after=next",
      secondary.id,
    );
    expect(result).toBe("/w/acme/sessions?q=auth&sort=oldest&factory=secondary-id");
  });

  it("resets caller-declared page params while keeping preserved filters", () => {
    const navigation = factorySwitchHref(
      "/w/acme/analytics",
      "factory=old&from=2026-05-01&to=2026-05-31&compare=previous&dimension=model&environment=staging&metric=throughput&period=compare&bucket=old&cursor=old&facet=old&routingCanary=old&routingAlert=alert",
      secondary.id,
      ["metric", "period", "facet", "bucket", "routingCanary", "routingAlert"],
    );
    expect(navigation).toBe(
      "/w/acme/analytics?factory=secondary-id&from=2026-05-01&to=2026-05-31&compare=previous&dimension=model&environment=staging",
    );
  });

  it("offers Governance only for factories the viewer manages", () => {
    const managed = { ...secondary, canManage: true };
    expect(resolveGovernanceFactorySelection([factory, managed], undefined)).toEqual({
      kind: "factory",
      factory: managed,
    });
    expect(resolveGovernanceFactorySelection([factory, managed], factory.id)).toEqual({
      kind: "unavailable",
    });
    expect(resolveGovernanceFactorySelection([managed], "all")).toEqual({ kind: "unavailable" });
  });

  it("carries explicit scope including duplicates without changing other query values", () => {
    expect(withFactoryQuery("/w/acme/runs", null)).toBe("/w/acme/runs");
    expect(withFactoryQuery("/w/acme/sessions?sort=number", ["all", secondary.id])).toBe(
      "/w/acme/sessions?sort=number&factory=all&factory=secondary-id",
    );
  });
});
