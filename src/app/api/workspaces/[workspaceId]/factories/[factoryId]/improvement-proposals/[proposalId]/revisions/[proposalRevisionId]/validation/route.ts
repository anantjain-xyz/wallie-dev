import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { factoryImprovementValidationCommandSchema } from "@/lib/factory-proposals/validation-contracts";
import {
  readFactoryImprovementValidation,
  startFactoryImprovementValidation,
} from "@/lib/factory-proposals/validation-server";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { wakeWorker } from "@/lib/worker/wake";

import { readBenchmarkCommand } from "../../../../../benchmarks/mutation-responses";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
    factoryId: string;
    proposalId: string;
    proposalRevisionId: string;
  }>;
};

const revisionScope = z.object({
  proposalId: factoryProposalUuidSchema,
  proposalRevisionId: factoryProposalUuidSchema,
});
const maxRequestBytes = 16 * 1024;

export async function GET(request: Request, context: RouteContext) {
  return handleRequest(request, context, "read");
}

export async function POST(request: Request, context: RouteContext) {
  if (!isSameOriginFactoryOAuthPost(request)) {
    return validationError("Send this request from Wallie.", 403);
  }
  return handleRequest(request, context, "start");
}

async function handleRequest(request: Request, { params }: RouteContext, action: "read" | "start") {
  try {
    const revision = revisionScope.safeParse(await params);
    if (!revision.success) {
      return validationError("Provide a valid improvement proposal and revision ID.", 400);
    }
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const scope = {
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId: context.access.user.id,
      ...revision.data,
      signal: request.signal,
    };

    if (action === "read") {
      const validation = await readFactoryImprovementValidation({
        ...scope,
        client: createSupabaseAdminClient(),
      });
      return validation
        ? Response.json({ validation }, { headers })
        : validationError("No comparison is available for this proposal revision.", 404);
    }

    const limit = await enforceRateLimit(
      "improvementProposals",
      `${context.workspaceId}:${context.access.user.id}`,
    );
    if (limit.response) {
      limit.response.headers.set("Cache-Control", headers["Cache-Control"]);
      return limit.response;
    }
    const command = await readBenchmarkCommand(
      request,
      factoryImprovementValidationCommandSchema,
      "Check the frozen suites, ordered candidates, execution limits, and acceptance thresholds.",
      maxRequestBytes,
    );
    if (!command.ok) return command.response;

    const { validation, replay } = await startFactoryImprovementValidation(
      { ...scope, client: createSupabaseAdminClient() },
      command.data,
    );
    if (!replay) await wakeWorker();
    return Response.json({ validation }, { status: replay ? 200 : 201, headers });
  } catch (error) {
    return validationFailure(error);
  }
}

function validationError(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

function validationFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "42501":
      return validationError("Only a factory manager can access proposal validation.", 403);
    case "P0002":
    case "PT404":
      return validationError("The proposal revision or its comparison is unavailable.", 404);
    case "P0011":
    case "PT409":
      return validationError(
        "The proposal, active base, or comparison changed. Reload and retry.",
        409,
      );
    case "PT412":
      return validationError("Select currently qualified Workerd benchmark configurations.", 412);
    case "22023":
    case "PT422":
      return validationError(
        "Review the exact suites, scorer, candidates, and acceptance thresholds.",
        422,
      );
    default:
      return validationError("Could not process the proposal comparison.", 500);
  }
}
