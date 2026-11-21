import "server-only";

import { z } from "zod";

import type { createSupabaseAdminClient } from "@/lib/supabase/admin";

import { replayDigestSchema, replaySha256 } from "./replay-contracts";

const id = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const profileSchema = z.enum(["blocked", "recorded_fixtures", "isolated_test"]);
const operationSchema = z.enum([
  "tool_read",
  "tool_write",
  "git_write",
  "chat_write",
  "issue_write",
  "deployment_write",
  "external_tool",
]);
const requestSchema = z.strictObject({
  operation: operationSchema,
  fixtureKey: replayDigestSchema.optional(),
});
const requestedOperationSchema = z.object({ operation: operationSchema });

const openInputSchema = z.object({
  workspaceId: id,
  factoryId: id,
  actorUserId: id,
  taskRevisionId: id,
  policyRevisionId: id,
  expectedPolicyDigest: replayDigestSchema,
  executionId: id,
  restorationReceiptSha256: replayDigestSchema,
});
const openResultSchema = z.object({
  id,
  workspace_id: id,
  factory_id: id,
  task_revision_id: id,
  policy_revision_id: id,
  policy_digest: replayDigestSchema,
  restoration_receipt_sha256: replayDigestSchema,
  created_by: id,
  profile: profileSchema,
});

const receiptIdentity = {
  executionId: id,
  operationId: id,
  operation: operationSchema,
  policyRevisionId: id,
  policyDigest: replayDigestSchema,
};
const denial = {
  decision: z.literal("denied"),
  reason: z.enum(["policy_blocked", "operation_blocked", "fixture_unavailable", "fixture_revoked"]),
  fixtureRevisionId: z.null(),
  fixtureResponseSha256: z.null(),
};
const stub = {
  decision: z.literal("stubbed"),
  reason: z.literal("fixture_matched"),
  fixtureRevisionId: id,
  fixtureResponseSha256: replayDigestSchema,
};
const maxFixtureResponseBytes = 65_536;
const fixtureResponseSchema = z
  .string()
  .max(maxFixtureResponseBytes)
  .refine((value) => {
    if (Buffer.byteLength(value, "utf8") > maxFixtureResponseBytes) return false;
    try {
      JSON.parse(value);
      return true;
    } catch {
      return false;
    }
  });
const recordResultSchema = z.discriminatedUnion("decision", [
  z.object({
    ...receiptIdentity,
    ...denial,
    fixtureKey: replayDigestSchema.nullable(),
    responseJson: z.null(),
  }),
  z.object({
    ...receiptIdentity,
    ...stub,
    fixtureKey: replayDigestSchema,
    responseJson: fixtureResponseSchema,
  }),
]);
const operationReceiptSchema = z.discriminatedUnion("decision", [
  z.object({ version: z.literal(1), ...receiptIdentity, ...denial }),
  z.object({ version: z.literal(1), ...receiptIdentity, ...stub }),
]);

export type BenchmarkReplayPolicyPermit = Readonly<{
  version: 1;
  executionId: string;
  workspaceId: string;
  factoryId: string;
  taskRevisionId: string;
  policyRevisionId: string;
  policyDigest: string;
  restorationReceiptSha256: string;
  profile: z.infer<typeof profileSchema>;
}>;
export type BenchmarkReplayOperationReceipt = z.infer<typeof operationReceiptSchema>;
type OperationResult =
  | {
      receipt: Extract<BenchmarkReplayOperationReceipt, { decision: "denied" }>;
      response?: never;
    }
  | {
      receipt: Extract<BenchmarkReplayOperationReceipt, { decision: "stubbed" }>;
      response: string;
    };

export type BenchmarkReplayBroker = Readonly<{
  permit: BenchmarkReplayPolicyPermit;
  invoke(
    request: unknown,
    options?: { operationId?: string; signal?: AbortSignal },
  ): Promise<OperationResult>;
}>;

function authorizationError() {
  return new Error("The replay policy could not authorize this operation.");
}

/** Only bounded identifiers, digests, and known decisions belong in exported evidence. */
export function exportBenchmarkReplayOperationReceipt(
  input: unknown,
): BenchmarkReplayOperationReceipt {
  const receipt = operationReceiptSchema.safeParse(input);
  if (!receipt.success) throw authorizationError();
  return receipt.data;
}

/** Pin a replay authority to one restoration and mediate calls without any upstream transport. */
export async function openBenchmarkReplayPolicy(
  input: z.input<typeof openInputSchema> & {
    admin: ReturnType<typeof createSupabaseAdminClient>;
    signal?: AbortSignal;
  },
): Promise<BenchmarkReplayBroker> {
  const { admin, signal } = input;
  signal?.throwIfAborted();
  const parsed = openInputSchema.safeParse(input);
  if (!parsed.success) throw authorizationError();
  const scope = parsed.data;
  const opening = admin.rpc("open_factory_benchmark_replay_execution", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_execution_id: scope.executionId,
    p_task_revision_id: scope.taskRevisionId,
    p_policy_revision_id: scope.policyRevisionId,
    p_expected_policy_digest: scope.expectedPolicyDigest,
    p_restoration_receipt_sha256: scope.restorationReceiptSha256,
  });
  const opened = await Promise.resolve(signal ? opening.abortSignal(signal) : opening).catch(
    () => null,
  );
  signal?.throwIfAborted();
  const authorization = openResultSchema.safeParse(opened?.data);
  if (!opened || opened.error || !authorization.success) throw authorizationError();
  const row = authorization.data;
  if (
    row.id !== scope.executionId ||
    row.workspace_id !== scope.workspaceId ||
    row.factory_id !== scope.factoryId ||
    row.task_revision_id !== scope.taskRevisionId ||
    row.policy_revision_id !== scope.policyRevisionId ||
    row.policy_digest !== scope.expectedPolicyDigest ||
    row.restoration_receipt_sha256 !== scope.restorationReceiptSha256 ||
    row.created_by !== scope.actorUserId
  ) {
    throw authorizationError();
  }
  const permit: BenchmarkReplayPolicyPermit = Object.freeze({
    version: 1,
    executionId: row.id,
    workspaceId: row.workspace_id,
    factoryId: row.factory_id,
    taskRevisionId: row.task_revision_id,
    policyRevisionId: row.policy_revision_id,
    policyDigest: row.policy_digest,
    restorationReceiptSha256: row.restoration_receipt_sha256,
    profile: row.profile,
  });

  return {
    permit,
    async invoke(request, options) {
      const deadline =
        signal && options?.signal
          ? AbortSignal.any([signal, options.signal])
          : (signal ?? options?.signal);
      deadline?.throwIfAborted();
      const parsedOperationId = id.safeParse(options?.operationId ?? crypto.randomUUID());
      if (!parsedOperationId.success) throw authorizationError();
      const operationId = parsedOperationId.data;
      const parsedRequest = requestSchema.safeParse(request);
      const method = parsedRequest.success
        ? parsedRequest
        : requestedOperationSchema.safeParse(request);
      const operation = method.success ? method.data.operation : "external_tool";
      const fixtureAllowed =
        operation !== "external_tool" &&
        (permit.profile === "isolated_test" ||
          (permit.profile === "recorded_fixtures" && operation === "tool_read"));
      const fixtureKey =
        fixtureAllowed && parsedRequest.success ? parsedRequest.data.fixtureKey : undefined;
      const recording = admin.rpc("record_factory_benchmark_replay_operation", {
        p_workspace_id: permit.workspaceId,
        p_factory_id: permit.factoryId,
        p_execution_id: permit.executionId,
        p_operation_id: operationId,
        p_operation: operation,
        ...(fixtureKey ? { p_fixture_key: fixtureKey } : {}),
      });
      const recorded = await Promise.resolve(
        deadline ? recording.abortSignal(deadline) : recording,
      ).catch(() => null);
      deadline?.throwIfAborted();
      const parsedRecord = recordResultSchema.safeParse(recorded?.data);
      if (!recorded || recorded.error || !parsedRecord.success) throw authorizationError();
      const record = parsedRecord.data;
      if (
        record.executionId !== permit.executionId ||
        record.operationId !== operationId ||
        record.operation !== operation ||
        record.policyRevisionId !== permit.policyRevisionId ||
        record.policyDigest !== permit.policyDigest ||
        record.fixtureKey !== (fixtureKey ?? null)
      ) {
        throw authorizationError();
      }

      const receipt = exportBenchmarkReplayOperationReceipt({ version: 1, ...record });
      if (record.decision === "denied" && receipt.decision === "denied") return { receipt };
      if (
        record.decision !== "stubbed" ||
        receipt.decision !== "stubbed" ||
        replaySha256(record.responseJson) !== record.fixtureResponseSha256
      ) {
        throw authorizationError();
      }
      return { receipt, response: record.responseJson };
    },
  };
}
