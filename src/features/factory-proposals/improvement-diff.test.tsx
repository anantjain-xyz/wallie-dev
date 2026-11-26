import { createClient } from "@supabase/supabase-js";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";

import {
  modelRoutingPolicySchema,
  type ModelRoutingConfiguration,
} from "@/lib/model-routing/contracts";
import type { Database } from "@/lib/supabase/database.types";

import { ImprovementDiff } from "./improvement-diff";

const id = (suffix: number) => `63900000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const target: ModelRoutingConfiguration = {
  agentId: id(1),
  definitionRevisionId: id(2),
  experimentId: id(3),
  qualificationId: id(4),
  modelKey: "openai/gpt-5.6-sol",
  harness: "codex",
  workerRuntime: "node",
};
const backup = { ...target, modelKey: "openai/gpt-5.6-luna" };
const taskClassId = id(5);

it.each(["primary", "fallback"] as const)(
  "shows a runtime-only change in the readable %s target",
  async (changedTarget) => {
    function policy(workerRuntime: ModelRoutingConfiguration["workerRuntime"]) {
      return JSON.stringify(
        modelRoutingPolicySchema.parse({
          version: 1,
          taskClasses: [{ id: taskClassId, slug: "maintenance", name: "Maintenance" }],
          rules: [
            {
              id: id(6),
              taskClassId,
              configuration: changedTarget === "primary" ? { ...target, workerRuntime } : target,
              constraints: {
                qualityFloorBps: 9000,
                maxMeanCostUsd: null,
                maxLatencyMs: null,
                minResolvedTrials: 2,
                minConfidenceBps: null,
              },
              onUnavailable: {
                kind: "fallback",
                configuration: changedTarget === "fallback" ? { ...backup, workerRuntime } : backup,
              },
            },
          ],
          onUnmatched: { kind: "escalate" },
        }),
      );
    }
    const supabase = createClient<Database>("https://fixture.invalid", "test-key", {
      auth: { persistSession: false },
      global: {
        fetch: async (input) => {
          const url = new URL(input instanceof Request ? input.url : input);
          return Response.json(
            url.pathname.endsWith("/factory_agents")
              ? [{ id: target.agentId, name: "Review agent" }]
              : [],
          );
        },
      },
    });
    const html = renderToStaticMarkup(
      await ImprovementDiff({
        proposal: {
          base: { activationNumber: 1, revisionId: id(2), digest: "a".repeat(64) },
          baseCurrent: true,
          candidate: { revisionId: id(7), digest: "b".repeat(64), definitionJson: "{}" },
          diff: {
            fields: [
              { label: "Model routing policy", before: policy("node"), after: policy("workerd") },
            ],
            stages: [],
          },
        },
        scope: { supabase, workspaceId: id(8), factoryId: id(9) },
      }),
    );
    const [readable] = html.split("<details");
    const [before, after] = readable.split("Proposed configuration");
    const label = changedTarget === "primary" ? target.modelKey : `Fallback: ${backup.modelKey}`;
    expect(before).toContain(`${label} · codex · Node.js · Review agent`);
    expect(after).toContain(`${label} · codex · Cloudflare Workers · Review agent`);
  },
);
