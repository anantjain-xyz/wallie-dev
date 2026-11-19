import assert from "node:assert/strict";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it } from "vitest";

import {
  assertOutcomeRuntimeOracle,
  assertOutcomeTenantScope,
  localOutcomeClient,
  outcomeRuntimeNativeConfig,
  readAuthoritativeOutcome,
  readOutcomeHealth,
} from "../../test/release/factory-outcome-runtime-oracle";
import type { Env } from "../index";

const bindings = env as unknown as Env & { WALLIE_FACTORY_OUTCOME_RUNTIME_FIXTURE?: string };
const raw = bindings.WALLIE_FACTORY_OUTCOME_RUNTIME_FIXTURE;

async function tickMaintenance() {
  const id = "m06-outcomes-" + crypto.randomUUID();
  const inspection = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
  try {
    await bindings.MAINTENANCE.create({ id, params: { tick: Math.floor(Date.now() / 60_000) } });
    await inspection.waitForStatus("complete");
  } finally {
    await inspection.dispose();
  }
}

it.skipIf(typeof raw !== "string")(
  "converges and repeats exact outcome evidence through actual native MAINTENANCE",
  async () => {
    assert(typeof raw === "string");
    const config = outcomeRuntimeNativeConfig.parse(JSON.parse(raw));
    const { scope, url, publishableKey, ownerToken, viewerToken } = config;
    const owner = localOutcomeClient(url, publishableKey, ownerToken);
    const viewer = localOutcomeClient(url, publishableKey, viewerToken);

    await assertOutcomeTenantScope(owner, viewer, scope);
    const before = await readOutcomeHealth(viewer, scope);
    assert.equal(before.status, "building");
    assert.equal(before.rebuild.state, "queued");
    const authority = await readAuthoritativeOutcome(owner, scope);

    await tickMaintenance();
    const settled = await readOutcomeHealth(viewer, scope);
    assert.equal(settled.status, "ready");
    assert.equal(settled.rebuild.state, "completed");
    assert.equal(settled.oldestPendingAt, null);
    assert.notEqual(settled.sourceSnapshotAt, before.sourceSnapshotAt);
    await assertOutcomeRuntimeOracle(viewer, config, "corrected");
    assert.deepEqual(await readAuthoritativeOutcome(owner, scope), authority);

    await tickMaintenance();
    const replay = await readOutcomeHealth(viewer, scope);
    assert.equal(replay.sourceSnapshotAt, settled.sourceSnapshotAt);
    assert.deepEqual(replay.rebuild, settled.rebuild);
    await assertOutcomeRuntimeOracle(viewer, config, "corrected");
    assert.deepEqual(await readAuthoritativeOutcome(owner, scope), authority);
  },
  90_000,
);
