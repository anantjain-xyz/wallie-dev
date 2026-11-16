import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FactoryDefinitionIsland } from "@/features/settings/islands/factory-definition-island";
import type { SettingsPageData } from "@/features/settings/data";
import type { CompiledFactoryDefinition } from "@/lib/factory-definitions/compiler";
import type { SettingsFactoryDefinitionState } from "@/lib/factory-definitions/settings-contracts";

const workspaceId = "54500000-0099-4000-8000-000000000001";
const now = "2026-11-15T20:00:00.000Z";

function makeDefinition(): CompiledFactoryDefinition {
  return {
    schemaVersion: 1,
    kind: "serial",
    pipelineId: "54500000-0099-4000-8000-000000000002",
    repositoryId: "54500000-0099-4000-8000-000000000003",
    sandboxProvider: "vercel",
    agent: {
      provider: "codex",
      model: "gpt-5.6-sol",
      effort: "xhigh",
      concurrencyLimit: 1,
      stallTimeoutMs: 900_000,
      maxRetries: 3,
      maxTurns: 5,
    },
    executionPolicyRevisionId: null,
    deliveryPolicyRevisionId: null,
    skillIds: [],
    toolIds: [],
    operatingRulesMd: "",
    operatingRuleStageIds: [],
    stages: [
      {
        id: "54500000-0099-4000-8000-000000000004",
        slug: "plan",
        name: "Plan",
        description: "",
        promptTemplateMd: "Plan {{session.prompt}}.",
        anyoneCanApprove: true,
        approverMemberIds: [],
        previousStageIds: [],
      },
    ],
  };
}

function makeInitialData(activationNumber: number): SettingsPageData {
  const def = makeDefinition();
  const factoryDefinition: SettingsFactoryDefinitionState = {
    factoryId: "54500000-0099-4000-8000-000000000005",
    expectedActivationNumber: activationNumber,
    currentActivation: {
      id: `activation-${activationNumber}`,
      revisionId: `54500000-0099-4000-8000-00000000001${activationNumber}`,
      activationNumber,
      previousActivationNumber: activationNumber > 1 ? activationNumber - 1 : null,
      canonicalDigest: `${activationNumber}a2b3c4d`.repeat(8),
      createdAt: now,
      definition: def,
    },
    latestDraft: null,
    activeDefinition: def,
    defaultRepositoryId: def.repositoryId,
    executionPolicy: null,
    deliveryPolicy: null,
    liveExecutionPolicyRevision: 0,
    liveDeliveryPolicyRevision: 0,
  };

  return {
    factoryDefinition,
    workspace: { id: workspaceId, name: "Acme", slug: "acme", avatarPath: null, avatarUrl: null },
  } as unknown as SettingsPageData;
}

describe("useFactoryDefinitionStore SSR isolation", () => {
  it("does not retain module-level store entries across server renders", () => {
    expect(typeof window).toBe("undefined");

    const firstHtml = renderToString(
      createElement(FactoryDefinitionIsland, { initialData: makeInitialData(1) }),
    );
    expect(firstHtml).toContain("Published #1");

    const secondHtml = renderToString(
      createElement(FactoryDefinitionIsland, { initialData: makeInitialData(2) }),
    );
    expect(secondHtml).toContain("Published #2");
    expect(secondHtml).not.toContain("Published #1");
  });
});
