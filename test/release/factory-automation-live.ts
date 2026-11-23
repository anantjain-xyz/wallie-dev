import assert from "node:assert/strict";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

import { z } from "zod/v4";

import {
  dispatchActionsDelivery,
  observeActionsDelivery,
} from "@/features/github/actions-delivery";
import {
  actionsDeliveryDispatch,
  actionsDeliveryObservation,
} from "@/lib/factory-delivery-commands/actions-contract";
import { factoryDeliveryCommandSchema } from "@/lib/factory-delivery-commands/contracts";
import { factoryDeploymentObservationRoute } from "@/lib/factory-deployments/contracts";
import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import { monitoringSignalReceiptSchema } from "@/lib/factory-monitoring/contracts";
import { encryptSecretValue } from "@/lib/secrets/crypto";

import {
  fixtureEnvironment,
  fixtureTagSchema,
  openLiveGitHubFixture,
} from "./factory-automation-live-github";
import { assertDeliverySucceeded } from "./factory-automation-runtime-oracle";
import { localOutcomeClient, rpcValue } from "./factory-outcome-runtime-oracle";

const uuid = z.uuid();
const seedSchema = z.object({
  workspaceId: uuid,
  factoryId: uuid,
  ownerId: uuid,
  bindingId: uuid,
  installationId: uuid,
  projectId: z.number().int().positive(),
  sourceId: uuid,
  commandId: uuid,
  sourceSessionId: uuid,
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  approvedHead: z.string().regex(/^[a-f0-9]{40}$/),
  approvalId: uuid,
  occurrenceId: uuid,
  automationMutationReceiptId: uuid,
});
const incidentSchema = z.object({
  incidentId: uuid,
  sessionId: uuid,
  sourceSessionId: uuid,
  commandId: uuid,
  deploymentId: uuid,
  observationId: uuid,
  sourceRevision: z.string(),
  mutationReceiptId: uuid,
  requestId: uuid,
  actorServicePrincipalId: uuid,
});
type Seed = z.infer<typeof seedSchema>;

function localUrl(raw: string, protocols: readonly string[]) {
  const url = new URL(raw);
  assert(
    protocols.includes(url.protocol) &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.search &&
      !url.hash,
    "The live fixture requires an isolated loopback Supabase project.",
  );
  return raw;
}

function readStack(directory: string) {
  const status = z
    .object({
      API_URL: z.string(),
      DB_URL: z.string(),
      SERVICE_ROLE_KEY: z.string().optional(),
      SECRET_KEY: z.string().optional(),
      ANON_KEY: z.string().optional(),
      PUBLISHABLE_KEY: z.string().optional(),
    })
    .parse(
      JSON.parse(
        execFileSync("supabase", ["status", "--workdir", directory, "--output", "json"], {
          env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 30_000,
        }),
      ),
    );
  const key = status.SERVICE_ROLE_KEY ?? status.SECRET_KEY;
  const publishableKey = status.ANON_KEY ?? status.PUBLISHABLE_KEY;
  assert(key && publishableKey, "Missing the local Supabase API keys.");
  return {
    url: localUrl(status.API_URL, ["http:"]),
    database: localUrl(status.DB_URL, ["postgresql:", "postgres:"]),
    key,
    publishableKey,
  };
}

function runSql(
  database: string,
  args: string[],
  variables: Record<`WALLIE_M12_${string}`, string> = {},
) {
  const connection = new URL(database);
  return execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", ...args], {
    env: {
      ...variables,
      NODE_ENV: "test",
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR,
      PGHOST: connection.hostname.replace(/^\[|\]$/g, ""),
      PGPORT: connection.port || "5432",
      PGDATABASE: decodeURIComponent(connection.pathname.slice(1)),
      PGUSER: decodeURIComponent(connection.username),
      PGPASSWORD: decodeURIComponent(connection.password),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    timeout: 30_000,
  }).trim();
}

async function localPort() {
  const server = createServer();
  return new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close((error) => {
        if (error) reject(error);
        else if (!address || typeof address === "string") reject(new Error("Missing local port."));
        else resolvePort(address.port);
      });
    });
  });
}

function isRunning(child: ChildProcess) {
  return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

async function stop(child: ChildProcess | undefined) {
  if (!child) return;
  const pid = child.pid;
  if (!pid || !isRunning(child)) return;
  process.kill(-pid, "SIGTERM");
  const limit = Date.now() + 10_000;
  while (isRunning(child) && Date.now() < limit) await delay(100);
  if (isRunning(child)) process.kill(-pid, "SIGKILL");
}

async function waitFor<T>(child: ChildProcess, timeout: number, read: () => Promise<T | null>) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    assert(isRunning(child), "The local fixture runtime exited before producing evidence.");
    const result = await read();
    if (result !== null) return result;
    await delay(500);
  }
  throw new Error("The local fixture runtime did not reach its expected state.");
}

function start(command: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string) {
  const child = spawn(command, args, { cwd, env, detached: true, stdio: "inherit" });
  child.once("error", () => console.error("[m12-live] A local runtime could not start."));
  return child;
}

function post(app: string, path: string, bytes: string, headers: Record<string, string> = {}) {
  return fetch(app + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: bytes,
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
}

function sentryBody(
  seed: Seed,
  input: { eventId: string; commandId?: string; sourceRevision?: string },
) {
  return JSON.stringify({
    action: "triggered",
    installation: { uuid: seed.installationId },
    data: {
      event: {
        event_id: input.eventId,
        issue_id: "751",
        project: seed.projectId,
        datetime: new Date().toISOString(),
        release: input.sourceRevision ?? seed.sourceRevision,
        tags: [
          ["wallie_delivery_command", input.commandId ?? seed.commandId],
          ["environment", fixtureEnvironment],
        ],
      },
    },
  });
}

function readIncident(database: string, scope: Seed, incidentId: string) {
  const raw = runSql(database, [
    "-c",
    `
    select json_build_object(
      'incidentId', incident.id, 'sessionId', incident.session_id, 'sourceSessionId', incident.causing_session_id,
      'commandId', incident.delivery_command_id, 'deploymentId', incident.deployment_id,
      'observationId', incident.observation_id, 'sourceRevision', incident.source_sha,
      'mutationReceiptId', incident.mutation_receipt_id, 'requestId', receipt.request_id,
      'actorServicePrincipalId', receipt.actor_service_principal_id
    ) from internal.factory_monitoring_incidents incident
    join internal.session_mutation_receipts receipt on receipt.id = incident.mutation_receipt_id
    join public.sessions session on (session.id, session.workspace_id, session.factory_id)
      = (incident.session_id, incident.workspace_id, incident.factory_id)
    where incident.id = '${incidentId}' and incident.workspace_id = '${scope.workspaceId}'
      and incident.factory_id = '${scope.factoryId}' and incident.status = 'admitted'
  `,
  ]);
  return raw ? incidentSchema.parse(JSON.parse(raw)) : null;
}

async function run() {
  const { values } = parseArgs({
    options: {
      workdir: { type: "string" },
      tag: { type: "string" },
      "app-dir": { type: "string" },
    },
  });
  assert(
    values.workdir && values.tag,
    "Pass --workdir <exclusive local Supabase project> and --tag <existing wallie-m12-fixture-* tag>.",
  );
  const appDirectory = resolve(values["app-dir"] ?? ".");
  for (const directory of new Set([resolve("."), appDirectory])) {
    assert(
      [".env", ".env.local", ".env.production", ".env.production.local"].every(
        (file) => !existsSync(resolve(directory, file)),
      ),
      "Run the live fixture from a checkout and app directory without environment files.",
    );
  }
  assert(
    existsSync(resolve(appDirectory, ".next/BUILD_ID")),
    "Build the production fixture app first.",
  );
  const stack = readStack(resolve(values.workdir));
  const admin = localOutcomeClient(stack.url, stack.key);
  const before = await admin.from("workspaces").select("id", { count: "exact", head: true });
  assert(
    !before.error && before.count === 0,
    "Use an exclusive local database reset without demo data.",
  );
  const github = await openLiveGitHubFixture(fixtureTagSchema.parse(values.tag));
  const key = randomBytes(32).toString("hex");
  const signingSecret = randomBytes(24).toString("base64url");
  const token = issueFactoryMachineTokenSecret();
  const port = await localPort();
  const appUrl = `http://127.0.0.1:${port}`;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR,
    NEXT_PUBLIC_APP_URL: appUrl,
    NEXT_PUBLIC_SUPABASE_URL: stack.url,
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: stack.publishableKey,
    SUPABASE_SECRET_KEY: stack.key,
    WALLIE_ENCRYPTION_KEY: key,
    NEXT_TELEMETRY_DISABLED: "1",
    WALLIE_SANDBOX_IMPL: "fake",
  };

  let app: ChildProcess | undefined;
  let worker: ChildProcess | undefined;
  let seed: Seed | undefined;
  const releaseWasEnabled =
    runSql(stack.database, [
      "-c",
      "select enabled from public.get_git_continuity_release_state()",
    ]) === "t";
  try {
    app = start(
      process.execPath,
      [
        resolve(appDirectory, "node_modules/next/dist/bin/next"),
        "start",
        "--hostname",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      env,
      appDirectory,
    );
    await waitFor(app, 35_000, async () => {
      try {
        const result = await fetch(appUrl, {
          redirect: "manual",
          signal: AbortSignal.timeout(1_000),
        });
        await result.body?.cancel();
        return result.status < 500 ? true : null;
      } catch {
        return null;
      }
    });
    const seeded = runSql(
      stack.database,
      ["-f", resolve("test/release/factory-automation-live-seed.psql")],
      {
        WALLIE_M12_TAG: github.tag,
        WALLIE_M12_SOURCE_SHA: github.sourceRevision,
        WALLIE_M12_REPORTER_ID: token.tokenId,
        WALLIE_M12_REPORTER_DIGEST: token.digest,
        WALLIE_M12_SENTRY_CIPHERTEXT: encryptSecretValue(signingSecret, {
          WALLIE_ENCRYPTION_KEY: key,
        }),
      },
    );
    seed = seedSchema.parse(JSON.parse(seeded.split("\n").at(-1) ?? ""));
    assert.equal(seed.sourceRevision, github.sourceRevision);
    assert.notEqual(seed.sourceRevision, seed.approvedHead);
    const scope = {
      p_workspace_id: seed.workspaceId,
      p_factory_id: seed.factoryId,
      p_command_id: seed.commandId,
    };
    const fixture = seed;
    const readDelivery = async () =>
      factoryDeliveryCommandSchema.parse(
        rpcValue(
          await admin.rpc("read_factory_delivery_command", {
            ...scope,
            p_actor_user_id: fixture.ownerId,
          }),
        ),
      );
    assert.equal((await readDelivery()).dispatchState, "queued");
    const target = actionsDeliveryDispatch.parse(
      rpcValue(await admin.rpc("claim_factory_actions_dispatch", scope)),
    );
    const transport = github.transport(target);
    const dispatched = await dispatchActionsDelivery({
      ...transport,
      target,
      signal: AbortSignal.timeout(22_000),
    });
    assert.equal(dispatched.kind, "unknown");
    assert(
      rpcValue(
        await admin.rpc("settle_factory_actions_dispatch", {
          ...scope,
          p_lease_id: target.leaseId,
          p_dispatch_state: "unknown",
          p_reason: "dispatch_unknown",
        }),
      ),
    );
    const unknown = await readDelivery();
    assert.equal(unknown.dispatchState, "unknown");
    assert.equal(unknown.outcome, "unknown");
    const duplicateClaim = await admin.rpc("claim_factory_actions_dispatch", scope);
    assert.equal(duplicateClaim.error, null);
    assert.equal(duplicateClaim.data, null);

    const evidence = await github.waitForEvidence(target);
    const reservations = actionsDeliveryObservation
      .array()
      .parse(rpcValue(await admin.rpc("reserve_factory_actions_observations")));
    assert.equal(reservations.length, 1);
    const reservation = reservations[0];
    assert(reservation);
    assert.equal(reservation.commandId, seed.commandId);
    assert.equal(
      reservation.runId,
      null,
      "The real dispatch response must not be known to Wallie.",
    );
    const observed = await observeActionsDelivery({
      ...transport,
      target: reservation,
      signal: AbortSignal.timeout(15_000),
    });
    assert(observed.kind === "observed");
    assert.deepEqual(observed, {
      kind: "observed",
      runId: evidence.runId,
      status: "completed",
      conclusion: "success",
    });
    assert(
      rpcValue(
        await admin.rpc("settle_factory_actions_observation", {
          ...scope,
          p_observation_id: reservation.observationId,
          p_reason: "run_verified",
          p_run_id: observed.runId,
          p_run_status: observed.status,
          p_run_conclusion: "success",
        }),
      ),
    );
    const runOnly = await readDelivery();
    assert.equal(runOnly.dispatchState, "accepted");
    assert.equal(runOnly.outcome, "pending");
    assert.equal(runOnly.actions?.runId, evidence.runId);
    assert.equal(runOnly.deploymentObservationId, null);
    console.log(
      "[m12-live] Recovered exactly one GitHub run after discarding its dispatch response",
      evidence.url,
    );

    const sentryPath = `/api/monitoring/sentry/${seed.bindingId}`;
    const deploymentPath = `/api/v1/workspaces/${seed.workspaceId}/factories/${seed.factoryId}/deployment-observations`;
    function sign(bytes: string) {
      return createHmac("sha256", signingSecret).update(bytes).digest("hex");
    }
    async function alert(bytes: string, status: number, signature = sign(bytes)) {
      const response = await post(appUrl, sentryPath, bytes, {
        "Sentry-Hook-Resource": "event_alert",
        "Sentry-Hook-Signature": signature,
      });
      assert.equal(response.status, status, "Unexpected Sentry-compatible alert status.");
      return response.json();
    }
    async function report(
      commandId: string,
      outcome: "succeeded" | "failed",
      revision: number,
      expectedStatus: number,
    ) {
      const body = JSON.stringify({
        sourceId: fixture.sourceId,
        environment: fixtureEnvironment,
        externalDeploymentId: commandId,
        revision,
        outcome,
        sourceRevision: fixture.sourceRevision,
        providerOccurredAt: evidence.completedAt,
      });
      const response = await post(appUrl, deploymentPath, body, {
        Authorization: `Bearer ${token.credential}`,
      });
      assert.equal(
        response.status,
        expectedStatus,
        "Unexpected authenticated deployment report status.",
      );
      const receipt = factoryDeploymentObservationRoute.response.parse(await response.json());
      assert.equal(receipt.outcome, outcome);
      assert.equal(receipt.sourceRevision, fixture.sourceRevision);
      assert(receipt.authoritativeOccurredAt);
      assert.equal(Date.parse(receipt.authoritativeOccurredAt), Date.parse(evidence.completedAt));
      return receipt;
    }

    const originalEventId = randomBytes(16).toString("hex");
    const original = sentryBody(seed, { eventId: originalEventId });
    assert.deepEqual(await alert(original, 401, "0".repeat(64)), { status: "unauthorized" });
    assert.deepEqual(await alert(original, 202), { status: "ignored" });
    const reportReceipt = await report(seed.commandId, "succeeded", 1, 201);
    assert.equal(
      (await report(seed.commandId, "succeeded", 1, 200)).observationId,
      reportReceipt.observationId,
    );
    const deployment = await readDelivery();
    assertDeliverySucceeded(deployment);
    assert.equal(deployment.deploymentObservationId, reportReceipt.observationId);

    const unmatched = sentryBody(seed, {
      eventId: randomBytes(16).toString("hex"),
      commandId: randomUUID(),
    });
    assert.deepEqual(await alert(unmatched, 202), { status: "ignored" });
    const wrongRevision = sentryBody(seed, {
      eventId: randomBytes(16).toString("hex"),
      sourceRevision: seed.approvedHead,
    });
    assert.deepEqual(await alert(wrongRevision, 202), { status: "ignored" });
    const queued = monitoringSignalReceiptSchema.parse(await alert(original, 202));
    assert(queued.status === "queued");
    assert.deepEqual(await alert(original, 202), {
      status: "duplicate",
      incidentId: queued.incidentId,
    });
    for (let count = 1; count < 30; count++) {
      const duplicateIssue = sentryBody(seed, { eventId: randomBytes(16).toString("hex") });
      assert.deepEqual(await alert(duplicateIssue, 202), {
        status: "suppressed",
        incidentId: queued.incidentId,
      });
    }
    assert.deepEqual(
      await alert(sentryBody(seed, { eventId: randomBytes(16).toString("hex") }), 429),
      { status: "rate_limited" },
    );
    console.log(
      "[m12-live] Authenticated M06 report and Sentry scope, replay, suppression and rate limits passed.",
    );

    worker = start("pnpm", ["worker"], env);
    const incident = await waitFor(worker, 85_000, async () =>
      readIncident(stack.database, fixture, queued.incidentId),
    );
    await stop(worker);
    worker = undefined;
    assert.equal(incident.sourceSessionId, seed.sourceSessionId);
    assert.equal(incident.commandId, seed.commandId);
    assert.equal(incident.deploymentId, reportReceipt.deploymentId);
    assert.equal(incident.observationId, reportReceipt.observationId);
    assert.equal(incident.sourceRevision, seed.sourceRevision);
    assert.equal(incident.requestId, incident.incidentId);
    assert.notEqual(incident.mutationReceiptId, seed.automationMutationReceiptId);
    const scheduleEvidence = runSql(stack.database, [
      "-c",
      `
      select count(*) from internal.factory_automation_occurrences occurrence
      join internal.session_mutation_receipts receipt on receipt.id = occurrence.mutation_receipt_id
      join internal.factory_delivery_commands command on command.session_id = occurrence.session_id
      where occurrence.id = '${seed.occurrenceId}' and occurrence.session_id = '${seed.sourceSessionId}'
        and occurrence.source_namespace = 'schedule' and occurrence.status = 'admitted'
        and receipt.request_id = occurrence.id and command.id = '${seed.commandId}'
        and command.approval_id = '${seed.approvalId}' and command.approved_head_sha = '${seed.approvedHead}'
        and command.source_sha = '${seed.sourceRevision}'
    `,
    ]);
    assert.equal(
      scheduleEvidence,
      "1",
      "The incident's causal delivery did not originate in the scheduled occurrence.",
    );
    const recursiveCommandId = randomUUID();
    runSql(stack.database, ["-f", resolve("test/release/factory-automation-live-recursion.psql")], {
      WALLIE_M12_LIVE_COMMAND: seed.commandId,
      WALLIE_M12_RECURSIVE_COMMAND: recursiveCommandId,
      WALLIE_M12_INCIDENT_SESSION: incident.sessionId,
    });
    await report(recursiveCommandId, "succeeded", 1, 201);
    assert.equal(
      runSql(stack.database, [
        "-c",
        `
      select count(*) from internal.factory_delivery_commands command
      where command.id = '${recursiveCommandId}' and command.session_id = '${incident.sessionId}'
        and command.dispatch_state = 'accepted' and command.outcome = 'succeeded'
        and not internal.factory_monitoring_cause_allowed(command.workspace_id, command.factory_id, command.session_id)
    `,
      ]),
      "1",
      "The recursive alert must target a real authenticated outcome from the incident session.",
    );
    const recursive = sentryBody(seed, {
      eventId: randomBytes(16).toString("hex"),
      commandId: recursiveCommandId,
    });
    assert.deepEqual(await alert(recursive, 202), { status: "ignored" });
    const failure = await report(seed.commandId, "failed", 2, 201);
    assert.equal((await readDelivery()).outcome, "failed");
    assert.notEqual(failure.observationId, reportReceipt.observationId);
    assert.deepEqual(
      await alert(sentryBody(seed, { eventId: randomBytes(16).toString("hex") }), 202),
      { status: "ignored" },
    );
    assert.equal(
      runSql(stack.database, [
        "-c",
        `select count(*) from internal.factory_monitoring_incidents
      where workspace_id = '${seed.workspaceId}' and factory_id = '${seed.factoryId}'`,
      ]),
      "1",
    );
    console.log(
      "[m12-live] One admitted incident retained the schedule, approval, delivery, and deployment evidence",
      JSON.stringify({
        occurrenceId: seed.occurrenceId,
        approvalId: seed.approvalId,
        commandId: seed.commandId,
        sourceRevision: seed.sourceRevision,
        approvedHead: seed.approvedHead,
        observationId: reportReceipt.observationId,
        incidentId: incident.incidentId,
        incidentSessionId: incident.sessionId,
        githubRun: evidence.url,
      }),
    );
  } finally {
    await stop(worker);
    await stop(app);
    const id = seed?.workspaceId ?? "66820000-0000-4000-8000-000000000011";
    runSql(stack.database, [
      "-c",
      `
      delete from public.workspaces where id = '${id}';
      delete from auth.users where id in ('66820000-0000-4000-8000-000000000001', '66820000-0000-4000-8000-000000000002');
      select public.set_git_continuity_release(false, revision, 'Restore isolated M12 fixture gate')
      from public.get_git_continuity_release_state() where enabled and not ${releaseWasEnabled};
    `,
    ]);
  }
}

void run().catch((error: unknown) => {
  console.error(
    "[m12-live]",
    error instanceof Error ? error.message : "Live qualification failed.",
  );
  process.exitCode = 1;
});
