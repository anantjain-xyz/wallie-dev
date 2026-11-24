import assert from "node:assert/strict";
import { introspectWorkflowInstance } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { it, vi } from "vitest";
import { z } from "zod/v4";

import { automationHistorySchema } from "@/lib/factory-automations/operator-contracts";
import {
  factoryDeliveryCandidateSchema,
  factoryDeliveryCommandSchema,
} from "@/lib/factory-delivery-commands/contracts";

import { localOutcomeClient, rpcValue } from "../../test/release/factory-outcome-runtime-oracle";
import type { Env } from "../index";

const bindings = env as unknown as Env & {
  WALLIE_FACTORY_AUTOMATION_RUNTIME_FIXTURE?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
};
const raw = bindings.WALLIE_FACTORY_AUTOMATION_RUNTIME_FIXTURE;
const linearApi = "https://api.linear.app/graphql";

const loopback = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) &&
    !url.username &&
    !url.password &&
    !url.search &&
    !url.hash
  );
});
const expectedCounts = z.record(
  z.string().regex(/^(pending|admitted|denied)(:[a-z_]+)?$/),
  z.number().int().positive().max(20),
);
const configSchema = z.strictObject({
  phase: z.enum(["intake", "recovery"]),
  url: loopback.refine((value) => new URL(value).pathname === "/"),
  publishableKey: z.string().min(1),
  ownerToken: z.string().min(1),
  ownerUserId: z.uuid(),
  workspaceId: z.uuid(),
  factoryId: z.uuid(),
  linearEndpoint: loopback.refine((value) => new URL(value).pathname === "/graphql"),
  witnesses: z
    .array(
      z.strictObject({ automationId: z.uuid(), before: expectedCounts, after: expectedCounts }),
    )
    .min(1)
    .refine((rows) => new Set(rows.map(({ automationId }) => automationId)).size === rows.length),
  delivery: z
    .strictObject({
      commandId: z.uuid(),
      workspaceId: z.uuid(),
      factoryId: z.uuid(),
      actorUserId: z.uuid(),
    })
    .optional(),
});
type Config = z.infer<typeof configSchema>;
type Client = ReturnType<typeof localOutcomeClient>;
type Point = "before" | "after";

async function tickMaintenance(phase: Config["phase"]) {
  const id = `m12-automation-${phase}-${crypto.randomUUID()}`;
  const inspection = await introspectWorkflowInstance(bindings.MAINTENANCE, id);
  try {
    await bindings.MAINTENANCE.create({ id, params: { tick: Math.floor(Date.now() / 60_000) } });
    await inspection.waitForStatus("complete");
  } finally {
    await inspection.dispose();
  }
}

async function assertHistory(owner: Client, config: Config, point: Point) {
  const admitted = new Map<string, number>();
  const sessionNumbers = new Set<number>();
  for (const witness of config.witnesses) {
    const history = automationHistorySchema.parse(
      rpcValue(
        await owner.rpc("list_factory_automation_occurrence_history", {
          p_workspace_id: config.workspaceId,
          p_factory_id: config.factoryId,
          p_automation_id: witness.automationId,
        }),
      ),
    );
    const scope = `${config.phase} ${point} automation ${witness.automationId}`;
    assert.equal(history.nextCursor, null, `${scope} must account for every occurrence.`);
    const expected = witness[point];
    const actual: Record<string, number> = {};
    for (const occurrence of history.occurrences) {
      const detailed = `${occurrence.status}:${occurrence.reason}`;
      const key = Object.hasOwn(expected, detailed) ? detailed : occurrence.status;
      actual[key] = (actual[key] ?? 0) + 1;
      if (occurrence.status !== "admitted") continue;
      assert(occurrence.sessionNumber !== null, `${scope} must link its admitted session.`);
      assert(
        !sessionNumbers.has(occurrence.sessionNumber),
        "An admitted session covered multiple occurrences.",
      );
      assert(!admitted.has(occurrence.id), "An admitted occurrence appeared more than once.");
      admitted.set(occurrence.id, occurrence.sessionNumber);
      sessionNumbers.add(occurrence.sessionNumber);
    }
    assert.deepEqual(actual, expected, `${scope} disposition counts changed.`);
  }
  return admitted;
}

async function readDelivery(admin: Client, delivery: NonNullable<Config["delivery"]>) {
  const command = factoryDeliveryCommandSchema.parse(
    rpcValue(
      await admin.rpc("read_factory_delivery_command", {
        p_workspace_id: delivery.workspaceId,
        p_factory_id: delivery.factoryId,
        p_actor_user_id: delivery.actorUserId,
        p_command_id: delivery.commandId,
      }),
    ),
  );
  assert.equal(command.id, delivery.commandId);
  return command;
}

it.skipIf(typeof raw !== "string")(
  "reconciles untouched synthetic automation witnesses through a fresh native MAINTENANCE process",
  async () => {
    assert(typeof raw === "string");
    const config = configSchema.parse(JSON.parse(raw));
    assert(
      config.phase === "intake" || config.delivery,
      "Recovery requires the fenced delivery witness.",
    );
    const origin = new URL(config.url).origin;
    assert.equal(
      new URL(loopback.parse(bindings.NEXT_PUBLIC_SUPABASE_URL)).origin,
      origin,
      "The worker and oracle must share a disposable stack.",
    );
    assert(bindings.SUPABASE_SECRET_KEY, "The disposable Supabase service key is required.");
    const serviceKey = bindings.SUPABASE_SECRET_KEY;
    const originalFetch = globalThis.fetch;
    async function fetchLoopback(input: Parameters<typeof fetch>[0], init?: RequestInit) {
      const response = await originalFetch(input, { ...init, redirect: "manual" });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error("The release fixture cannot follow a redirect.");
      }
      return response;
    }
    const unexpectedOrigins = new Set<string>();
    let linearRequests = 0;
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.origin === origin) return fetchLoopback(request);
      if (url.href === linearApi) {
        assert.equal(request.method, "POST");
        linearRequests++;
        return fetchLoopback(config.linearEndpoint, {
          method: request.method,
          headers: request.headers,
          body: await request.arrayBuffer(),
          signal: request.signal,
        });
      }
      unexpectedOrigins.add(url.origin);
      throw new Error("The release fixture cannot contact an external provider.");
    });
    try {
      const owner = localOutcomeClient(origin, config.publishableKey, config.ownerToken);
      const identity = await localOutcomeClient(origin, config.publishableKey).auth.getUser(
        config.ownerToken,
      );
      assert(
        !identity.error && identity.data.user.id === config.ownerUserId,
        "Expected the synthetic factory manager.",
      );
      const admin = localOutcomeClient(origin, serviceKey);
      const before = await assertHistory(owner, config, "before");
      const started = config.delivery ? await readDelivery(admin, config.delivery) : null;
      if (started) {
        assert.equal(started.dispatchState, "dispatching");
        assert.equal(started.outcome, null);
        assert.equal(started.deploymentObservationId, null);
        assert(started.dispatchStartedAt);
      }

      await tickMaintenance(config.phase);
      assert(linearRequests > 0, "Native maintenance must exercise the actual Linear reconciler.");

      const after = await assertHistory(owner, config, "after");
      if (config.phase === "intake") {
        assert(after.size > before.size, "Native intake must admit fresh work.");
      } else {
        assert(before.size > 0, "Native recovery must read work settled before the restart.");
      }
      for (const [occurrenceId, sessionNumber] of before) {
        assert.equal(
          after.get(occurrenceId),
          sessionNumber,
          "Maintenance changed settled occurrence ownership.",
        );
      }

      if (config.delivery && started) {
        const recovered = await readDelivery(admin, config.delivery);
        assert.equal(recovered.dispatchState, "unknown");
        assert.equal(recovered.outcome, "unknown");
        assert.equal(recovered.deploymentObservationId, null);
        assert.equal(recovered.dispatchStartedAt, started.dispatchStartedAt);
        assert.deepEqual(
          factoryDeliveryCandidateSchema.parse(recovered),
          factoryDeliveryCandidateSchema.parse(started),
        );
      }
      assert.deepEqual([...unexpectedOrigins], []);
    } finally {
      vi.unstubAllGlobals();
    }
  },
  90_000,
);
