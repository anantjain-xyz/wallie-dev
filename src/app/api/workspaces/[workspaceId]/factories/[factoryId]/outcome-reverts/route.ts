import { verifyFactoryRevertPullRequest } from "@/features/github/factory-revert-verification";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import {
  factoryRevertCoverageReceiptSchema,
  factoryRevertRelationshipReceiptSchema,
  factoryRevertRequestSchema,
  factoryRevertTargetSchema,
} from "@/lib/factory-outcomes/revert-contracts";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Json } from "@/lib/supabase/database.types";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };
type ReceiptSchema =
  | typeof factoryRevertCoverageReceiptSchema
  | typeof factoryRevertRelationshipReceiptSchema;

function failure(status: number, error: string) {
  return Response.json({ error }, { status, headers });
}

function rpcFailure(code: string) {
  const status = code === "PT403" ? 403 : code === "PT404" ? 404 : factoryErrorStatus(code);
  return failure(status, "Could not record factory revert evidence.");
}

function reply(
  schema: ReceiptSchema,
  { data, error }: { data: Json; error: { code: string } | null },
) {
  if (error) return rpcFailure(error.code);
  const result = schema.safeParse(data);
  return result.success
    ? Response.json(result.data, { headers })
    : failure(500, "Could not read the revert evidence receipt.");
}

export async function POST(request: Request, { params }: Context) {
  const context = await resolveFactoryRouteContext(params);
  if (!context.ok) return context.response;
  if (new URL(request.url).search) return failure(400, "Unexpected revert evidence query.");

  const raw = await readBoundedJsonBody(request, 4096);
  if (!raw.ok) {
    if (raw.code === "request_too_large") return failure(413, "The request is too large.");
    if (raw.code === "unsupported_media_type")
      return failure(415, "Send the request as application/json.");
    return failure(400, "Invalid revert evidence command.");
  }
  const command = factoryRevertRequestSchema.safeParse(raw.body);
  if (!command.success) return failure(400, "Invalid revert evidence command.");

  const admin = createSupabaseAdminClient();
  const scope = {
    p_workspace_id: context.workspaceId,
    p_factory_id: context.factoryId,
    p_actor_user_id: context.access.user.id,
  };
  const input = command.data;
  if (input.action === "coverage") {
    return reply(
      factoryRevertCoverageReceiptSchema,
      await admin
        .rpc("record_factory_revert_coverage", {
          ...scope,
          p_repository_id: input.repositoryId,
          p_base_branch: input.baseBranch,
          p_from: input.from,
          p_through: input.through,
          p_request_id: input.requestId,
        })
        .abortSignal(request.signal),
    );
  }
  if (input.action === "withdrawCoverage") {
    return reply(
      factoryRevertCoverageReceiptSchema,
      await admin
        .rpc("withdraw_factory_revert_coverage", {
          ...scope,
          p_coverage_id: input.coverageId,
        })
        .abortSignal(request.signal),
    );
  }

  const relationship = {
    ...scope,
    p_original_merge_id: input.originalMergeId,
    p_revert_pr_number: input.revertPrNumber,
    p_expected_revision: input.expectedRevision,
    p_request_id: input.requestId,
    p_status: input.status,
  };
  if (input.status !== "confirmed") {
    return reply(
      factoryRevertRelationshipReceiptSchema,
      await admin.rpc("save_factory_revert_relationship", relationship).abortSignal(request.signal),
    );
  }

  const { data, error } = await admin
    .rpc("get_factory_revert_target", {
      ...scope,
      p_original_merge_id: input.originalMergeId,
    })
    .abortSignal(request.signal);
  if (error) return rpcFailure(error.code);
  const target = factoryRevertTargetSchema.safeParse(data);
  if (!target.success || target.data.mergeId !== input.originalMergeId) {
    return failure(500, "Could not read the original merge evidence.");
  }
  const verification = await verifyFactoryRevertPullRequest({
    target: target.data,
    revertPrNumber: input.revertPrNumber,
    signal: request.signal,
  });
  if (!verification.ok) {
    return verification.code === "unverified"
      ? failure(422, "GitHub did not confirm an eligible merged revert pull request.")
      : failure(503, "GitHub verification is unavailable.");
  }
  return reply(
    factoryRevertRelationshipReceiptSchema,
    await admin
      .rpc("save_factory_revert_relationship", {
        ...relationship,
        p_original_observation_id: target.data.observationId,
        p_proof: verification.proof,
      })
      .abortSignal(request.signal),
  );
}
