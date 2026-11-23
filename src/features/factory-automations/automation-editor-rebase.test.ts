import { expect, it } from "vitest";

import { factoryAutomationDefinitionSchema } from "@/lib/factory-automations/contracts";

import { rebaseAutomationDraft } from "./automation-editor-rebase";

function fixtureId(slot: number) {
  return `66410000-0000-4000-8000-${String(slot).padStart(12, "0")}`;
}

const original = factoryAutomationDefinitionSchema.parse({
  name: "Review changes",
  trigger: { kind: "schedule", cron: "0 9 * * *", timeZone: "Etc/UTC" },
  filters: {},
  target: { kind: "agent", definitionRevisionId: fixtureId(1), agentId: fixtureId(2) },
  executionGrant: { id: fixtureId(3), version: 1 },
  servicePrincipalId: fixtureId(4),
  budgetPayerMemberId: fixtureId(5),
  credentialBindingId: fixtureId(6),
});

const latest = factoryAutomationDefinitionSchema.parse({
  ...original,
  trigger: { kind: "schedule", cron: "0 11 * * *", timeZone: "Etc/UTC" },
});

it("keeps the other manager's trigger when the local edit only changes the rule name", () => {
  const mine = { ...original, name: "Review my changes" };
  const expected = { ...latest, name: mine.name };
  expect(rebaseAutomationDraft(original, mine, latest)).toEqual({
    conflicts: [],
    keepEdits: expected,
    keepSaved: expected,
  });
});

it("flags divergent event edits and keeps the chosen trigger paired with its filters", () => {
  const mine = factoryAutomationDefinitionSchema.parse({
    ...original,
    trigger: { kind: "issue-state" },
    filters: { stateIds: ["in-progress"], teamIds: [], projectIds: [] },
  });
  const saved = { ...latest, name: "Updated by the other manager" };
  expect(rebaseAutomationDraft(original, mine, saved)).toEqual({
    conflicts: ["Trigger and filters"],
    keepEdits: { ...mine, name: saved.name },
    keepSaved: saved,
  });
});
