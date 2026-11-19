import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { seedFactoryOutcomeRelease } from "../../e2e/helpers/factory-outcome-release";
import { assertFactoryOutcomeExportReconciles } from "../../e2e/helpers/reconcile-factory-outcome-export";
import {
  assertOutcomeRuntimeOracle,
  assertOutcomeTenantScope,
  controlOutcomeProjection,
  localOutcomeClient,
  outcomeRuntimeNativeConfig,
  readAuthoritativeOutcome,
  readOutcomeHealth,
  rpcValue,
} from "./factory-outcome-runtime-oracle";

type Client = ReturnType<typeof localOutcomeClient>;

async function localAccessToken(admin: Client, url: string, publishableKey: string, email: string) {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  assert(!link.error, "Could not create the disposable local login link.");
  const login = await localOutcomeClient(url, publishableKey).auth.verifyOtp({
    type: "email",
    token_hash: link.data.properties.hashed_token,
  });
  assert(
    !login.error && login.data.session,
    "Could not authenticate to the disposable local stack.",
  );
  return login.data.session.access_token;
}

function runningProcessGroup(pid: number) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

async function withDaemon(run: (isRunning: () => boolean) => Promise<void>) {
  const child = spawn("pnpm", ["worker"], {
    // This parent was started with the launcher’s small, loopback-only environment.
    env: process.env,
    detached: true,
    stdio: "inherit",
  });
  let failed = false;
  child.on("error", () => {
    failed = true;
  });
  try {
    await run(() => !failed && child.exitCode === null && child.signalCode === null);
  } finally {
    const pid = child.pid;
    if (pid && runningProcessGroup(pid)) {
      process.kill(-pid, "SIGTERM");
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && runningProcessGroup(pid)) await delay(100);
      if (runningProcessGroup(pid)) {
        process.kill(-pid, "SIGKILL");
        throw new Error("The local daemon did not finish graceful shutdown.");
      }
    }
  }
}

async function waitForDaemonBatch(isRunning: () => boolean, ready: () => Promise<boolean>) {
  const timeout = Date.now() + 85_000;
  while (Date.now() < timeout) {
    assert(isRunning(), "The local daemon exited before its scheduled maintenance batch.");
    if (await ready()) return;
    await delay(500);
  }
  throw new Error("The local daemon did not converge after its 60-second maintenance cycle.");
}

async function runNative(config: ReturnType<typeof outcomeRuntimeNativeConfig.parse>) {
  const started = spawn(
    process.execPath,
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "cloudflare/tests/factory-outcome-runtime.fixture.test.ts",
      "--config",
      "cloudflare/vitest.config.mts",
    ],
    {
      env: { ...process.env, WALLIE_FACTORY_OUTCOME_RUNTIME_FIXTURE: JSON.stringify(config) },
      stdio: "inherit",
      timeout: 120_000,
      killSignal: "SIGTERM",
    },
  );
  await new Promise<void>((done, reject) => {
    started.once("error", reject);
    started.once("exit", (code) => {
      if (code === 0) done();
      else reject(new Error("Native factory outcome maintenance did not pass."));
    });
  });
}

async function run() {
  assert(
    !existsSync(resolve(".env.local")),
    "Run M06 qualification from a worktree without .env.local.",
  );
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const secretKey = process.env.SUPABASE_SECRET_KEY;
  assert(
    url && publishableKey && secretKey,
    "Start M06 qualification with a disposable local stack.",
  );

  const admin = localOutcomeClient(url, secretKey);
  const workspaces = await admin.from("workspaces").select("id", { count: "exact", head: true });
  assert(
    !workspaces.error && workspaces.count === 0,
    "Use a disposable database reset without demo data.",
  );

  const fixture = await seedFactoryOutcomeRelease(url);
  try {
    const [ownerToken, viewerToken] = await Promise.all([
      localAccessToken(admin, url, publishableKey, fixture.ownerEmail),
      localAccessToken(admin, url, publishableKey, fixture.viewerEmail),
    ]);
    const owner = localOutcomeClient(url, publishableKey, ownerToken);
    const viewer = localOutcomeClient(url, publishableKey, viewerToken);
    const initial = outcomeRuntimeNativeConfig.parse({
      url,
      publishableKey,
      ownerToken,
      viewerToken,
      scope: fixture,
      receipts: {
        mergeObservationId: fixture.mergeObservationId,
        deploymentObservationId: fixture.deploymentObservationId,
      },
      expected: fixture.expected,
    });
    const { scope } = initial;

    await assertOutcomeTenantScope(owner, viewer, scope);
    await assertOutcomeRuntimeOracle(viewer, initial, "baseline");
    const initialHealth = await readOutcomeHealth(viewer, scope);
    assert.equal(initialHealth.status, "ready");
    assert(initialHealth.sourceSnapshotAt);
    console.log("[m06] Baseline Analytics values and exact evidence match the synthetic oracle.");

    const paused = await controlOutcomeProjection(owner, scope, "pause");
    assert.equal(paused.status, "paused");
    const late = await fixture.applyLateCorrection();
    assert.deepEqual(
      await fixture.applyLateCorrection(),
      late,
      "Provider replay must resolve the same corrected receipts.",
    );
    const corrected = outcomeRuntimeNativeConfig.parse({ ...initial, receipts: late });
    assert.notEqual(corrected.receipts.mergeObservationId, initial.receipts.mergeObservationId);
    assert.notEqual(
      corrected.receipts.deploymentObservationId,
      initial.receipts.deploymentObservationId,
    );
    await fixture.observePendingRequest();

    const pinned = await readAuthoritativeOutcome(owner, scope);
    const siblingQueued = await controlOutcomeProjection(
      owner,
      scope,
      "rebuild",
      scope.siblingFactoryId,
    );
    assert.equal(siblingQueued.rebuild.state, "queued");
    assert((await readOutcomeHealth(viewer, scope)).oldestPendingAt);
    await withDaemon((isRunning) =>
      waitForDaemonBatch(isRunning, async () => {
        const sibling = await readOutcomeHealth(owner, scope, scope.siblingFactoryId);
        return sibling.status === "ready" && sibling.rebuild.state === "completed";
      }),
    );
    const whilePaused = await readOutcomeHealth(viewer, scope);
    assert.equal(whilePaused.status, "paused");
    assert(whilePaused.oldestPendingAt);
    assert.equal(whilePaused.sourceSnapshotAt, initialHealth.sourceSnapshotAt);
    assert.deepEqual(await readAuthoritativeOutcome(owner, scope), pinned);
    console.log(
      "[m06] Scheduled Node maintenance drained the sibling while the selected projection stayed paused.",
    );

    const resumed = await controlOutcomeProjection(owner, scope, "resume");
    assert.equal(resumed.status, "building");
    const rebuild = await controlOutcomeProjection(owner, scope, "rebuild");
    assert.equal(rebuild.rebuild.state, "queued");
    const replay = await controlOutcomeProjection(owner, scope, "rebuild");
    assert.equal(replay.rebuild.requestedAt, rebuild.rebuild.requestedAt);
    await withDaemon((isRunning) =>
      waitForDaemonBatch(isRunning, async () => {
        const health = await readOutcomeHealth(viewer, scope);
        return health.status === "ready" && health.rebuild.state === "completed";
      }),
    );
    const recovered = await readOutcomeHealth(viewer, scope);
    assert(
      recovered.sourceSnapshotAt &&
        Date.parse(recovered.sourceSnapshotAt) > Date.parse(initialHealth.sourceSnapshotAt),
    );
    assert.equal(recovered.oldestPendingAt, null);
    await assertOutcomeRuntimeOracle(viewer, corrected, "corrected");
    assert.deepEqual(await readAuthoritativeOutcome(owner, scope), pinned);
    console.log(
      "[m06] Restarted Node maintenance converged to corrected Analytics values and exact receipts.",
    );

    const nativeQueued = await controlOutcomeProjection(owner, scope, "rebuild");
    assert.equal(nativeQueued.rebuild.state, "queued");
    await runNative(corrected);
    await assertOutcomeRuntimeOracle(viewer, corrected, "corrected");
    assert.deepEqual(await readAuthoritativeOutcome(owner, scope), pinned);

    const exportScope = { p_workspace_id: scope.workspaceId, p_factory_id: scope.factoryId };
    const capture = rpcValue(
      await viewer.rpc("create_factory_analytics_export", {
        ...exportScope,
        p_from: scope.from,
        p_to: scope.to,
        p_dimension: "source",
        p_environment: "production",
        p_compare_previous: true,
        p_request_id: crypto.randomUUID(),
      }),
    );
    assert(
      capture &&
        typeof capture === "object" &&
        !Array.isArray(capture) &&
        typeof capture.id === "string",
    );
    const json = rpcValue(
      await viewer.rpc("read_factory_analytics_export", {
        ...exportScope,
        p_export_id: capture.id,
      }),
    );
    assertFactoryOutcomeExportReconciles(JSON.parse(json));
    console.log(
      "[m06] Native MAINTENANCE replay, scoped evidence, authoritative records, and frozen export reconciled.",
    );
  } finally {
    await fixture.cleanup();
  }
}

run().catch((error: unknown) => {
  // This script only emits fixed assertion labels, never local auth details.
  if (error instanceof Error) {
    console.error("[m06] " + error.message.split("\n")[0]);
    console.error(
      error.stack?.split("\n").find((line) => line.includes("factory-outcome-runtime")),
    );
  } else {
    console.error("[m06] Disposable runtime qualification failed.");
  }
  process.exitCode = 1;
});
