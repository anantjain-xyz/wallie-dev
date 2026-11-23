import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { z } from "zod/v4";

import {
  factoryDeliveryCandidateSchema,
  factoryDeliveryCommandSchema,
} from "@/lib/factory-delivery-commands/contracts";

import {
  seedAutomationInput,
  sendGitHubFixture,
  startLinearFixture,
  type AutomationFixtureGitHubBranch,
  type AutomationInputScope,
} from "./factory-automation-input";
import {
  assertDeliverySucceeded,
  assertIntake,
  fixtureSql,
  readDispatchHistory,
  readIntake,
  seedDelivery,
  type DeliveryScope,
  type IntakeWitness,
} from "./factory-automation-runtime-oracle";
import { localOutcomeClient, rpcValue } from "./factory-outcome-runtime-oracle";

const runtimeEnv = z
  .object({
    NEXT_PUBLIC_APP_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
    SUPABASE_SECRET_KEY: z.string().min(1),
    GITHUB_WEBHOOK_SECRET: z.string().min(32),
    WALLIE_M12_DATABASE_URL: z.string().url(),
  })
  .parse(process.env);
const {
  NEXT_PUBLIC_APP_URL: appUrl,
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: publicKey,
  SUPABASE_SECRET_KEY: serviceKey,
  GITHUB_WEBHOOK_SECRET: webhookSecret,
  WALLIE_M12_DATABASE_URL: databaseUrl,
} = runtimeEnv;
for (const endpoint of [appUrl, supabaseUrl, databaseUrl]) {
  assert(
    ["127.0.0.1", "localhost", "[::1]"].includes(new URL(endpoint).hostname),
    "Use a dedicated loopback stack.",
  );
}
const admin = localOutcomeClient(supabaseUrl, serviceKey);
const shutdown = new AbortController();
const stop = () => shutdown.abort(new Error("M12 runtime qualification interrupted."));
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
type Broker = Awaited<ReturnType<typeof startLinearFixture>>;
type Counts = Record<string, number>;
type NativeCounts = Record<keyof AutomationInputScope["rules"], Counts>;

const received: NativeCounts = {
  schedule: {},
  github: { pending: 1 },
  linear: {},
  paused: { pending: 1 },
  revoked: {},
};
const baseline: NativeCounts = {
  schedule: { admitted: 1 },
  github: { admitted: 1 },
  linear: {},
  paused: { "pending:paused": 1 },
  revoked: {},
};
const admitted: NativeCounts = { ...baseline, linear: { admitted: 1 } };
const revoked: NativeCounts = { ...admitted, revoked: { "denied:invalid_assignment": 1 } };

async function replayGitHub(scope: AutomationInputScope, branch: AutomationFixtureGitHubBranch) {
  const deliveryId = randomUUID();
  for (const identity of [deliveryId, deliveryId, randomUUID()]) {
    await sendGitHubFixture(appUrl, webhookSecret, scope, branch, identity);
  }
}

async function queueIntake(scope: AutomationInputScope) {
  await replayGitHub(scope, "main");
  await replayGitHub(scope, "qualification-paused");
}

async function revokeAndReplay(scope: AutomationInputScope) {
  const grant = rpcValue(
    await admin.rpc("revoke_factory_execution_grant", {
      p_workspace_id: scope.workspaceId,
      p_factory_id: scope.factoryId,
      p_actor_user_id: scope.ownerUserId,
      p_grant_id: scope.grant.id,
      p_expected_version: scope.grant.version,
      p_reason: "M12 qualification",
    }),
  );
  assert(grant.revoked_at);
  await replayGitHub(scope, "qualification-revoked");
}

function deliveryArgs(scope: DeliveryScope, commandId = scope.commandId) {
  return {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_command_id: commandId,
  };
}

async function readCommand(scope: DeliveryScope, commandId = scope.commandId) {
  return factoryDeliveryCommandSchema.parse(
    rpcValue(
      await admin.rpc("read_factory_delivery_command", {
        ...deliveryArgs(scope, commandId),
        p_actor_user_id: scope.actorUserId,
      }),
    ),
  );
}

async function assertNoSecondClaim(scope: DeliveryScope) {
  const result = await admin.rpc("claim_factory_delivery_command", {
    ...deliveryArgs(scope),
    p_provider: "fixture-ci",
  });
  assert(!result.error, "The repeated claim must return a clean denial.");
  assert.equal(result.data, null);
}

async function armDelivery(scope: DeliveryScope) {
  const args = { ...deliveryArgs(scope), p_provider: "fixture-ci" };
  const lease = factoryDeliveryCommandSchema
    .extend({
      leaseId: z.string().uuid(),
      leaseExpiresAt: z.string().datetime({ offset: true }),
    })
    .parse(rpcValue(await admin.rpc("claim_factory_delivery_command", args)));
  assert.equal(lease.id, scope.commandId);
  assert.equal(lease.dispatchState, "dispatching");
  assert.equal(lease.outcome, null);
  assert.equal(lease.deploymentObservationId, null);
  await assertNoSecondClaim(scope);
  return lease;
}

async function checkRecovery(scope: DeliveryScope, held: Awaited<ReturnType<typeof armDelivery>>) {
  const command = await readCommand(scope);
  assert.equal(command.dispatchState, "unknown");
  assert.equal(command.outcome, "unknown");
  assert.equal(command.deploymentObservationId, null);
  assert.equal(command.dispatchStartedAt, held.dispatchStartedAt);
  assert.deepEqual(
    factoryDeliveryCandidateSchema.parse(command),
    factoryDeliveryCandidateSchema.parse(held),
  );
  assert.throws(() => assertDeliverySucceeded(command), /Provider acceptance is required/);
  await assertNoSecondClaim(scope);
  assert.equal(
    rpcValue(
      await admin.rpc("settle_factory_delivery_dispatch", {
        ...deliveryArgs(scope),
        p_lease_id: held.leaseId,
        p_dispatch_state: "accepted",
      }),
    ),
    false,
  );
  assert.deepEqual(readDispatchHistory(databaseUrl, scope), [
    ["queued", null, null],
    ["dispatching", null, null],
    ["unknown", "unknown", null],
  ]);
  const failed = await readCommand(scope, scope.failedCommandId);
  assert.equal(failed.dispatchState, "accepted");
  assert.equal(failed.outcome, "failed");
  assert(
    failed.deploymentObservationId,
    "The negative outcome must be based on an actual M06 receipt.",
  );
  assert.throws(() => assertDeliverySucceeded(failed), /Deployment outcome did not succeed/);
}

function assertStableAdmissions(before: IntakeWitness, after: IntakeWitness) {
  for (const row of before.occurrences) {
    const replayed = after.occurrences.find(({ id }) => id === row.id);
    assert.deepEqual(
      replayed,
      row,
      "A replay changed an existing occurrence or execution receipt.",
    );
  }
}

async function waitForNode(isRunning: () => boolean, ready: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 145_000;
  while (Date.now() < deadline) {
    shutdown.signal.throwIfAborted();
    assert(isRunning(), "The Node daemon exited before its maintenance witness settled.");
    if (await ready()) return;
    await delay(1_500, undefined, { signal: shutdown.signal });
  }
  throw new Error("Node maintenance did not settle the expected M12 receipts.");
}

function startFixtureProcess(args: string[], env: NodeJS.ProcessEnv, group = false) {
  const child = spawn(process.execPath, args, { env, detached: group, stdio: "inherit" });
  let closed = false;
  const running = () => !closed && child.exitCode === null && child.signalCode === null;
  const finished = new Promise<number>((complete) => {
    child.once("error", () => {
      closed = true;
      complete(1);
    });
    child.once("close", (code) => {
      closed = true;
      complete(code ?? 1);
    });
  });
  function signal(value: NodeJS.Signals) {
    if (!running()) return;
    if (group && child.pid) {
      try {
        process.kill(-child.pid, value);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !("code" in error) ||
          (error.code !== "ESRCH" && error.code !== "EPERM")
        ) {
          throw error;
        }
      }
    }
    child.kill(value);
  }
  return {
    running,
    finished,
    async stop() {
      signal("SIGTERM");
      const stopped = await Promise.race([
        finished.then(() => true),
        delay(12_000, false, { ref: false }),
      ]);
      if (stopped) return;
      signal("SIGKILL");
      await finished;
      throw new Error("An isolated M12 worker did not finish shutting down.");
    },
  };
}

async function withNodeDaemon<T>(broker: Broker, run: (isRunning: () => boolean) => Promise<T>) {
  shutdown.signal.throwIfAborted();
  const worker = startFixtureProcess(
    [
      "--import",
      "./scripts/install-crash-handlers.mjs",
      "--import",
      "./scripts/register-server-only.mjs",
      "--import",
      "tsx",
      "src/worker/index.ts",
    ],
    {
      ...process.env,
      NODE_OPTIONS: "--import ./test/release/factory-automation-runtime-fetch.mjs",
      WALLIE_M12_LINEAR_ENDPOINT: broker.endpoint,
      WALLIE_SANDBOX_IMPL: "fake",
    },
  );
  try {
    return await run(worker.running);
  } finally {
    await worker.stop();
  }
}

async function qualifyNode(scope: AutomationInputScope, delivery: DeliveryScope, broker: Broker) {
  await queueIntake(scope);
  const firstPhase = await withNodeDaemon(broker, async (running) => {
    await waitForNode(running, () => {
      const state = readIntake(databaseUrl, scope);
      return (
        state.linear.length >= 1 &&
        state.occurrences.some((row) => row.status === "admitted") &&
        state.occurrences.some((row) => row.reason === "paused") &&
        state.occurrences.filter(({ status }) => status === "admitted").length >= 2
      );
    });
    assertIntake(readIntake(databaseUrl, scope), scope, "baseline");
    broker.advance(scope.workspaceId);
    await waitForNode(running, () =>
      readIntake(databaseUrl, scope).occurrences.some(
        (row) => row.namespace === "linear.issue-state" && row.status === "admitted",
      ),
    );
    const intake = readIntake(databaseUrl, scope);
    assertIntake(intake, scope, "admitted");
    return { intake, held: await armDelivery(delivery) };
  });

  await revokeAndReplay(scope);
  const previousPolls = broker.observations(scope.workspaceId).matching;
  await withNodeDaemon(broker, (running) =>
    waitForNode(running, async () => {
      const command = await readCommand(delivery);
      const state = readIntake(databaseUrl, scope);
      return (
        command.dispatchState === "unknown" &&
        state.occurrences.some((row) => row.status === "denied") &&
        broker.observations(scope.workspaceId).matching > previousPolls
      );
    }),
  );
  const afterRestart = readIntake(databaseUrl, scope);
  assertIntake(afterRestart, scope, "revoked");
  assertStableAdmissions(firstPhase.intake, afterRestart);
  await checkRecovery(delivery, firstPhase.held);
  console.log("[m12] Node daemon restart preserved exact occurrence and delivery ownership.");
}

async function ownerToken(scope: AutomationInputScope) {
  const user = await admin.auth.admin.getUserById(scope.ownerUserId);
  assert(!user.error && user.data.user.email, "The synthetic manager needs a local address.");
  const magic = await admin.auth.admin.generateLink({
    type: "magiclink",
    email: user.data.user.email,
  });
  assert(!magic.error, "Could not issue the synthetic manager login.");
  const verified = await localOutcomeClient(supabaseUrl, publicKey).auth.verifyOtp({
    type: "email",
    token_hash: magic.data.properties.hashed_token,
  });
  assert(!verified.error && verified.data.session);
  return verified.data.session.access_token;
}

async function runNative(
  scope: AutomationInputScope,
  broker: Broker,
  managerToken: string,
  before: NativeCounts,
  after: NativeCounts,
  delivery?: DeliveryScope,
) {
  shutdown.signal.throwIfAborted();
  const witness = {
    phase: delivery ? "recovery" : "intake",
    url: supabaseUrl,
    publishableKey: publicKey,
    ownerToken: managerToken,
    ownerUserId: scope.ownerUserId,
    workspaceId: scope.workspaceId,
    factoryId: scope.factoryId,
    linearEndpoint: broker.endpoint,
    witnesses: (Object.keys(scope.rules) as (keyof NativeCounts)[]).map((name) => ({
      automationId: scope.rules[name].automationId,
      before: before[name],
      after: after[name],
    })),
    ...(delivery && {
      delivery: {
        workspaceId: delivery.workspaceId,
        factoryId: delivery.factoryId,
        actorUserId: delivery.actorUserId,
        commandId: delivery.commandId,
      },
    }),
  };
  const worker = startFixtureProcess(
    [
      resolve("node_modules/vitest/vitest.mjs"),
      "run",
      "cloudflare/tests/factory-automation-runtime.fixture.test.ts",
      "--config",
      "cloudflare/vitest.config.mts",
    ],
    { ...process.env, WALLIE_FACTORY_AUTOMATION_RUNTIME_FIXTURE: JSON.stringify(witness) },
    true,
  );
  const timeout = new AbortController();
  try {
    const exit = await Promise.race([
      worker.finished,
      delay(120_000, undefined, {
        ref: false,
        signal: AbortSignal.any([shutdown.signal, timeout.signal]),
      }).then(() => {
        throw new Error("Native M12 maintenance timed out.");
      }),
    ]);
    assert.equal(exit, 0, "Native M12 maintenance failed.");
  } finally {
    timeout.abort();
    await worker.stop();
  }
}

async function qualifyNative(scope: AutomationInputScope, delivery: DeliveryScope, broker: Broker) {
  const manager = await ownerToken(scope);
  await queueIntake(scope);
  await runNative(scope, broker, manager, received, baseline);
  assertIntake(readIntake(databaseUrl, scope), scope, "baseline");
  broker.advance(scope.workspaceId);

  const held = await armDelivery(delivery);
  await runNative(scope, broker, manager, baseline, admitted);
  const intake = readIntake(databaseUrl, scope);
  assertIntake(intake, scope, "admitted");
  assert.equal((await readCommand(delivery)).dispatchState, "dispatching");

  await revokeAndReplay(scope);
  await delay(Math.max(0, Date.parse(held.leaseExpiresAt) - Date.now() + 1_000), undefined, {
    signal: shutdown.signal,
  });
  await runNative(
    scope,
    broker,
    manager,
    { ...admitted, revoked: { pending: 1 } },
    revoked,
    delivery,
  );
  const afterRestart = readIntake(databaseUrl, scope);
  assertIntake(afterRestart, scope, "revoked");
  assertStableAdmissions(intake, afterRestart);
  await checkRecovery(delivery, held);
  console.log("[m12] Fresh Workerd maintenance preserved exact occurrence and delivery ownership.");
}

async function qualify() {
  assert.equal(
    fixtureSql(databaseUrl, "select count(*) from public.workspaces;"),
    "0",
    "Run with a freshly reset disposable database and demo seeding disabled.",
  );
  const nodeScope = await seedAutomationInput(databaseUrl, "66811001");
  const nodeDelivery = seedDelivery(databaseUrl, "66811002");
  const nodeBroker = await startLinearFixture([nodeScope]);
  try {
    await qualifyNode(nodeScope, nodeDelivery, nodeBroker);
  } finally {
    await nodeBroker.close();
  }

  const nativeScope = await seedAutomationInput(databaseUrl, "66812001");
  const nativeDelivery = seedDelivery(databaseUrl, "66812002");
  const nativeBroker = await startLinearFixture([nodeScope, nativeScope]);
  nativeBroker.advance(nodeScope.workspaceId);
  try {
    await qualifyNative(nativeScope, nativeDelivery, nativeBroker);
  } finally {
    await nativeBroker.close();
  }
}

void qualify()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "M12 qualification failed.");
    process.exitCode = 1;
  })
  .finally(() => {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  });
