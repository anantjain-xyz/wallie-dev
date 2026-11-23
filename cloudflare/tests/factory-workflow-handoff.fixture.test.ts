import assert from "node:assert/strict";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";
import { z } from "zod";

import { createFactoryRuntimeClients } from "../../test/release/factory-runtime-fixture";
import {
  getWorkflowHandoffResult,
  readWorkflowHandoff,
  workflowHandoffWitness,
} from "../../test/release/factory-workflow-handoff-contract";
import type { Env } from "../index";

const bindings = env as unknown as Env;
const raw = bindings.WALLIE_FACTORY_RUNTIME_FIXTURE;
const handoff =
  typeof raw === "string"
    ? z.object({ m11Handoff: workflowHandoffWitness }).safeParse(JSON.parse(raw)).data?.m11Handoff
    : undefined;

it.skipIf(!handoff)(
  "recovers the exact authored graph in a fresh native maintenance workflow",
  async () => {
    assert(handoff && typeof raw === "string");
    const { admin } = createFactoryRuntimeClients(raw);
    const pending = await readWorkflowHandoff(admin, handoff);
    assert.deepEqual(pending.results, []);

    for (let attempt = 0; attempt < 4; attempt++) {
      const id = `m11-handoff-${crypto.randomUUID()}`;
      const instance = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
      try {
        await bindings.MAINTENANCE.create({ id, params: { tick: Date.now() } });
        await instance.waitForStatus("complete");
      } finally {
        await instance.dispose();
      }
      const graph = await readWorkflowHandoff(admin, handoff);
      if (graph.occurrences.some(({ node_id }) => node_id === "human.review")) {
        assert.equal(
          getWorkflowHandoffResult(graph, "old.checkpoint"),
          `checkpoint:${handoff.inputRunId}`,
        );
        assert.equal(
          getWorkflowHandoffResult(graph, "check.policy"),
          `policy:${handoff.policyRevisionId}`,
        );
        assert.equal(getWorkflowHandoffResult(graph, "human.review"), null);
        assert.equal(graph.results.length, 2);
        return;
      }
    }

    throw new Error("Native maintenance did not reach the independent human gate.");
  },
  90_000,
);
