import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { resolveSourceDeliveryRepository } from "@/lib/pipeline/source-delivery";
import {
  readRetainedSourceRefInSandbox,
  restoreAndPushSourceInSandbox,
} from "@/lib/pipeline/source-delivery-sandbox";
import type { Database } from "@/lib/supabase/database.types";

import {
  publishClaimedRepositoryCheckpoint,
  type PublicationLease,
} from "./repository-publication";

type Admin = SupabaseClient<Database>;
type DeliveryScope =
  Database["public"]["Functions"]["list_factory_workflow_repository_deliveries"]["Returns"][number];
const uuid = z.string().uuid();
const sha = z.string().regex(/^[a-f0-9]{40}$/);
const safeInteger = z.number().int().positive().safe();
const leaseReceipt = z.object({
  target: z.object({
    workspace_id: uuid,
    factory_id: uuid,
    root_session_id: uuid,
    parent_session_id: uuid,
    join_id: uuid,
    repository_id: uuid,
    repository_numeric_id: safeInteger,
    installation_numeric_id: safeInteger,
    repository_full_name: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    expected_head_receipt_id: uuid,
    base_sha: sha,
    grant_id: uuid,
    grant_version: safeInteger,
  }),
  intent: z.object({
    candidate_sha: sha,
    tree_sha: sha,
    bundle_sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    retained_ref: z.string().nullable(),
  }),
  validation: z.object({ validation_run_id: uuid }),
  generation: safeInteger,
  leaseId: uuid,
  expiresAt: z.string().datetime({ offset: true }),
});

async function deliverRepository(admin: Admin, scope: DeliveryScope) {
  const claimScope = {
    p_root_session_id: scope.root_session_id,
    p_workspace_id: scope.workspace_id,
    p_factory_id: scope.factory_id,
    p_generation: scope.generation,
    p_owner: scope.ownership_token,
    p_join_id: scope.join_id,
    p_repository_id: scope.repository_id,
  };
  const claimed = await admin
    .rpc("claim_factory_workflow_repository_delivery", claimScope)
    .abortSignal(AbortSignal.timeout(5_000));
  if (claimed.error) throw claimed.error;
  if (!claimed.data) return;
  const { target, intent, validation, generation, leaseId, expiresAt } = leaseReceipt.parse(
    claimed.data,
  );
  if (
    target.workspace_id !== scope.workspace_id ||
    target.factory_id !== scope.factory_id ||
    target.root_session_id !== scope.root_session_id ||
    target.join_id !== scope.join_id ||
    target.repository_id !== scope.repository_id ||
    generation !== scope.generation
  )
    throw new Error("Repository delivery returned a different lease.");

  const shared = {
    scope: {
      workspaceId: target.workspace_id,
      factoryId: target.factory_id,
      rootSessionId: target.root_session_id,
      parentSessionId: target.parent_session_id,
      joinId: target.join_id,
    },
    repositoryId: target.repository_id,
    repositoryNumericId: target.repository_numeric_id,
    repositoryFullName: target.repository_full_name,
    expectedHeadReceiptId: target.expected_head_receipt_id,
    baseSha: target.base_sha,
    grantId: target.grant_id,
    grantVersion: target.grant_version,
    validationRunId: validation.validation_run_id,
    candidateSha: intent.candidate_sha,
    validationTreeSha: intent.tree_sha,
  };
  if ((intent.bundle_sha256 === null) !== (intent.retained_ref === null))
    throw new Error("The retained publication intent is incomplete.");
  const lease: PublicationLease = {
    generation,
    leaseId,
    expiresAt,
    target:
      intent.bundle_sha256 && intent.retained_ref
        ? { ...shared, bundleSha256: intent.bundle_sha256, retainedRef: intent.retained_ref }
        : { ...shared, bundleSha256: null, retainedRef: null },
  };
  const delivery = {
    workspace_id: target.workspace_id,
    repository_id: target.repository_id,
    repository_full_name: target.repository_full_name,
  };
  const sandbox = { admin, workspaceId: scope.workspace_id, runId: validation.validation_run_id };

  async function credentials(purpose: "checkout" | "execution", signal: AbortSignal) {
    const current = await resolveSourceDeliveryRepository(admin, delivery, signal, purpose);
    if (
      current.repositoryNumericId !== target.repository_numeric_id ||
      current.delivery.installation_id !== target.installation_numeric_id ||
      current.delivery.repository_full_name !== target.repository_full_name
    )
      throw new Error("The repository delivery installation changed.");
    return {
      remoteUrl: `https://github.com/${current.delivery.repository_full_name}.git`,
      token: current.token,
    };
  }

  await publishClaimedRepositoryCheckpoint(
    {
      async settle(captured, request) {
        const proof = "proof" in request ? request.proof : undefined;
        const result = await admin
          .rpc("settle_factory_workflow_repository_delivery", {
            ...claimScope,
            p_claim_id: captured.leaseId,
            p_action: request.action,
            ...(proof
              ? {
                  p_remote_repository_id: proof.repositoryNumericId,
                  ...(proof.ref ? { p_remote_ref: proof.ref } : {}),
                  ...(proof.sha ? { p_remote_sha: proof.sha } : {}),
                }
              : {}),
          })
          .abortSignal(AbortSignal.timeout(5_000));
        if (result.error) throw result.error;
        return result.data;
      },
    },
    {
      async read(checkpoint, signal) {
        const remote = await credentials("checkout", signal);
        const found = await readRetainedSourceRefInSandbox(
          { ...remote, ref: checkpoint.retainedRef, signal },
          sandbox,
        );
        return found
          ? {
              repositoryNumericId: checkpoint.repositoryNumericId,
              ref: checkpoint.retainedRef,
              sha: found,
            }
          : null;
      },
      async push(checkpoint, beforePush, signal) {
        const raw = await admin
          .rpc("read_factory_workflow_repository_bundle", {
            ...claimScope,
            p_claim_id: lease.leaseId,
          })
          .abortSignal(signal);
        if (raw.error || !raw.data)
          throw new Error("The retained repository bundle is unavailable.");
        const remote = await credentials("execution", signal);
        await restoreAndPushSourceInSandbox(
          {
            ...remote,
            baseSha: checkpoint.baseSha,
            headSha: checkpoint.candidateSha,
            sha256: checkpoint.bundleSha256,
            bytes: Buffer.from(raw.data, "base64"),
            retainedRef: checkpoint.retainedRef,
            runId: checkpoint.validationRunId,
            beforePush,
            signal,
          },
          sandbox,
        );
      },
    },
    lease,
  );
}

export async function drainFactoryWorkflowRepositoryDeliveries(admin: Admin) {
  let dispatchFailure: { reason: unknown } | undefined;
  try {
    for (let processed = 0; processed < 4; processed++) {
      const { data, error } = await admin
        .rpc("dispatch_next_factory_workflow_repository_validation")
        .abortSignal(AbortSignal.timeout(5_000));
      if (error) throw error;
      if (!data) break;
    }
  } catch (reason) {
    dispatchFailure = { reason };
  }

  const { data, error } = await admin
    .rpc("list_factory_workflow_repository_deliveries")
    .abortSignal(AbortSignal.timeout(5_000));
  if (error) throw error;
  await Promise.all(
    data.map(async (scope) => {
      try {
        await deliverRepository(admin, scope);
      } catch {
        console.warn("[factory-workflow] repository delivery will retry", {
          rootSessionId: scope.root_session_id,
          repositoryId: scope.repository_id,
          joinId: scope.join_id,
        });
      }
    }),
  );
  if (dispatchFailure) throw dispatchFailure.reason;
}
