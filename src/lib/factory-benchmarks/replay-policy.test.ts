import { createClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import { replaySha256 } from "./replay-contracts";
import { exportBenchmarkReplayOperationReceipt, openBenchmarkReplayPolicy } from "./replay-policy";

const id = (last: number) => `00000000-0000-4000-8000-${String(last).padStart(12, "0")}`;
const scope = {
  workspaceId: id(1),
  factoryId: id(2),
  actorUserId: id(3),
  executionId: id(4),
  taskRevisionId: id(5),
  policyRevisionId: id(6),
  expectedPolicyDigest: "a".repeat(64),
  restorationReceiptSha256: "b".repeat(64),
};
const fixtureKey = "c".repeat(64);
const fixtureRevisionId = id(7);
const fixtureEndpoint = "https://unapproved.example/private";
const fixtureSecret = "private-fixture-access-token";
const responseJson = JSON.stringify({ value: fixtureSecret, endpoint: fixtureEndpoint });

function policyStore(
  profile: "blocked" | "recorded_fixtures" | "isolated_test",
  reply: (args: Record<string, unknown>) => unknown = () => ({}),
) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    expect(url.origin).toBe("https://database.example");
    const name = url.pathname.split("/").at(-1) ?? "";
    const args = z.record(z.string(), z.unknown()).parse(JSON.parse(String(init?.body)));
    calls.push({ name, args });
    if (name === "open_factory_benchmark_replay_execution") {
      return Response.json({
        id: scope.executionId,
        workspace_id: scope.workspaceId,
        factory_id: scope.factoryId,
        created_by: scope.actorUserId,
        task_revision_id: scope.taskRevisionId,
        policy_revision_id: scope.policyRevisionId,
        policy_digest: scope.expectedPolicyDigest,
        restoration_receipt_sha256: scope.restorationReceiptSha256,
        created_at: "2026-11-21T12:00:00Z",
        profile,
      });
    }
    expect(name).toBe("record_factory_benchmark_replay_operation");
    const result = await reply(args);
    if (result instanceof Response) return result;
    return Response.json({
      executionId: scope.executionId,
      operationId: args.p_operation_id,
      operation: args.p_operation,
      policyRevisionId: scope.policyRevisionId,
      policyDigest: scope.expectedPolicyDigest,
      fixtureKey: args.p_fixture_key ?? null,
      decision: "denied",
      reason: "operation_blocked",
      fixtureRevisionId: null,
      fixtureResponseSha256: null,
      responseJson: null,
      ...(typeof result === "object" && result !== null ? result : {}),
    });
  });
  const admin = createClient<Database>("https://database.example", "test-server-role-key", {
    global: { fetch: fetcher },
  });
  return { calls, open: () => openBenchmarkReplayPolicy({ admin, ...scope }) };
}

const matchedFixture = {
  decision: "stubbed",
  reason: "fixture_matched",
  fixtureRevisionId,
  fixtureResponseSha256: replaySha256(responseJson),
  responseJson,
};

describe("benchmark replay operation boundary", () => {
  it("denies attempted Git, chat, issue, deployment, and unapproved tool writes without forwarding them", async () => {
    const { calls, open } = policyStore("recorded_fixtures");
    const broker = await open();
    const attacks = [
      { operation: "git_write", command: "git push", destination: fixtureEndpoint },
      { operation: "chat_write", method: "chat.postMessage", authorization: fixtureSecret },
      { operation: "issue_write", arguments: { body: fixtureSecret } },
      { operation: "deployment_write", endpoint: fixtureEndpoint },
      { operation: "tool_write", fixtureKey },
      { operation: "tool_read", fixtureKey, endpoint: fixtureEndpoint },
      { operation: "arbitrary_mcp_call", endpoint: fixtureEndpoint, credentials: fixtureSecret },
    ];
    for (const [index, attack] of attacks.entries()) {
      const result = await broker.invoke(attack, { operationId: id(20 + index) });
      expect(result).toEqual({ receipt: expect.objectContaining({ decision: "denied" }) });
    }
    const attempts = calls.slice(1);
    expect(attempts).toHaveLength(attacks.length);
    expect(attempts.map(({ args }) => args.p_operation)).toEqual([
      "git_write",
      "chat_write",
      "issue_write",
      "deployment_write",
      "tool_write",
      "tool_read",
      "external_tool",
    ]);
    expect(attempts.every(({ args }) => args.p_fixture_key === undefined)).toBe(true);
    expect(JSON.stringify(calls)).not.toContain(fixtureEndpoint);
    expect(JSON.stringify(calls)).not.toContain(fixtureSecret);
  });

  it("waits for exact fixture evidence before returning the same isolated result on retry", async () => {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const store = policyStore("isolated_test", () => promise);
    const broker = await store.open();
    const invoke = () =>
      broker.invoke({ operation: "chat_write", fixtureKey }, { operationId: id(8) });
    const first = invoke();
    const delivered = vi.fn();
    void first.then(delivered);
    await vi.waitFor(() => expect(store.calls).toHaveLength(2));
    expect(delivered).not.toHaveBeenCalled();
    resolve(matchedFixture);

    const result = await first;
    expect(result).toEqual(await invoke());
    expect(result.response).toBe(responseJson);
    expect(result.receipt).toMatchObject({
      version: 1,
      decision: "stubbed",
      fixtureRevisionId,
      fixtureResponseSha256: replaySha256(responseJson),
    });
    const exported = exportBenchmarkReplayOperationReceipt({
      ...result.receipt,
      fixtureKey,
      responseJson,
    });
    expect(exported).toEqual(result.receipt);
    expect(exported).not.toHaveProperty("fixtureKey");
    expect(JSON.stringify(exported)).not.toContain(fixtureSecret);
    expect(JSON.stringify(exported)).not.toContain(fixtureEndpoint);
    expect(store.calls[2].args).toEqual(store.calls[1].args);
  });

  it("accepts only a recorded read for the recorded-fixtures profile", async () => {
    const { open } = policyStore("recorded_fixtures", (args) =>
      args.p_fixture_key === fixtureKey ? matchedFixture : {},
    );
    const broker = await open();
    await expect(broker.invoke({ operation: "tool_read", fixtureKey })).resolves.toMatchObject({
      receipt: { decision: "stubbed" },
      response: responseJson,
    });
    await expect(broker.invoke({ operation: "tool_write", fixtureKey })).resolves.toMatchObject({
      receipt: { decision: "denied" },
    });
  });

  it("suppresses the fixture key when the policy blocks every operation", async () => {
    const { calls, open } = policyStore("blocked", () => ({ reason: "policy_blocked" }));
    const broker = await open();
    await expect(broker.invoke({ operation: "tool_read", fixtureKey })).resolves.toMatchObject({
      receipt: { decision: "denied", reason: "policy_blocked" },
    });
    expect(calls[1].args.p_fixture_key).toBeUndefined();
  });

  it("does not deliver a fixture after the operation has been canceled", async () => {
    const staged = Promise.withResolvers<unknown>();
    const { calls, open } = policyStore("recorded_fixtures", () => staged.promise);
    const broker = await open();
    const controller = new AbortController();
    const running = broker.invoke(
      { operation: "tool_read", fixtureKey },
      { signal: controller.signal },
    );
    await vi.waitFor(() => expect(calls).toHaveLength(2));
    controller.abort();
    staged.resolve(matchedFixture);
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  it("enforces fixture size in UTF-8 bytes", async () => {
    const oversized = JSON.stringify("é".repeat(40_000));
    const { open } = policyStore("recorded_fixtures", () => ({
      ...matchedFixture,
      responseJson: oversized,
      fixtureResponseSha256: replaySha256(oversized),
    }));
    const broker = await open();
    await expect(broker.invoke({ operation: "tool_read", fixtureKey })).rejects.toThrow(
      "The replay policy could not authorize this operation.",
    );
  });

  it.each([
    { fixtureResponseSha256: "0".repeat(64) },
    { responseJson: `${responseJson} ` },
    { responseJson: "invalid json", fixtureResponseSha256: replaySha256("invalid json") },
    { operationId: id(100) },
    { policyDigest: "0".repeat(64) },
    { fixtureKey: "0".repeat(64) },
  ])(
    "fails closed when the committed fixture transmission does not match its evidence",
    async (change) => {
      const { open } = policyStore("recorded_fixtures", () => ({ ...matchedFixture, ...change }));
      const broker = await open();
      await expect(broker.invoke({ operation: "tool_read", fixtureKey })).rejects.toThrow(
        "The replay policy could not authorize this operation.",
      );
    },
  );

  it("releases no fixture when the record RPC fails, even if its error includes secrets", async () => {
    const { open } = policyStore("isolated_test", () =>
      Response.json(
        { code: "42501", message: `${fixtureSecret} ${fixtureEndpoint}` },
        { status: 403 },
      ),
    );
    const broker = await open();
    await expect(broker.invoke({ operation: "tool_read", fixtureKey })).rejects.toThrow(
      /^The replay policy could not authorize this operation\.$/,
    );
  });
});
