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

  it.each(["analytics", "overview"])(
    "preserves outcome filters and clears scoped evidence when changing the factory on %s",
    (route) => {
      const path = `/w/acme/${route}`;
      expect(isFactorySelectorPath(path, "acme")).toBe(true);
      expect(isFactoryAggregatePath(path, "acme")).toBe(false);
      const navigation = factorySwitchHref(
        path,
        "factory=old&from=2026-05-01&to=2026-05-31&compare=previous&dimension=model&environment=staging&metric=throughput&period=compare&bucket=old&cursor=old&facet=old",
        secondary.id,
      );
      expect(navigation).toBe(
        `${path}?factory=secondary-id&from=2026-05-01&to=2026-05-31&compare=previous&dimension=model&environment=staging`,
      );
    },
  );

  it("keeps scorer list navigation scoped without carrying over revision and pagination IDs", () => {
    expect(isFactorySelectorPath("/w/acme/scorers", "acme")).toBe(true);
    expect(isFactorySelectorPath("/w/acme/scorers/1", "acme")).toBe(false);
    expect(
      factorySwitchHref("/w/acme/scorers", "after=cursor&revision=previous", secondary.id),
    ).toBe("/w/acme/scorers?factory=secondary-id");
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

it("switches Context and Memory to the selected factory and clears scoped history", () => {
  expect(isFactorySelectorPath("/w/acme/context", "acme")).toBe(true);
  expect(isFactorySelectorPath("/w/acme/memory", "acme")).toBe(true);
  expect(isFactoryAggregatePath("/w/acme/memory", "acme")).toBe(false);
  expect(
    factorySwitchHref(
      "/w/acme/context",
      "factory=old&source=s&revision=r&grantAfter=g&repoAfter=p",
      "new-factory",
    ),
  ).toBe("/w/acme/context?factory=new-factory");
  expect(
    factorySwitchHref(
      "/w/acme/memory",
      "factory=old&memory=m&revision=r&decision=d&proposal=a&version=2",
      "new-factory",
    ),
  ).toBe("/w/acme/memory?factory=new-factory");
});

it("clears an Analytics scorer cohort and drilldown when switching factories", () => {
  expect(
    factorySwitchHref(
      "/w/acme/analytics",
      "factory=old&from=2026-11-01&to=2026-12-01&cohort=c&scorerRevision=r&scoreSnapshot=s&evaluationDay=d&evaluationStatus=fail&beforeRunFinishedAt=at&beforeScoreRun=run&beforeRevisionAt=rat&beforeRevisionPolicy=rid&beforeCohortAt=cat&beforeCohortPolicy=cid",
      "new-factory",
    ),
  ).toBe("/w/acme/analytics?factory=new-factory&from=2026-11-01&to=2026-12-01");
});
