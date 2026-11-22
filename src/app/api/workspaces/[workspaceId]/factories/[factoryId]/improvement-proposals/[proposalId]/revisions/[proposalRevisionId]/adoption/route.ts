import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryImprovementAdoptionCommandSchema } from "@/lib/factory-proposals/adoption-contracts";
import {
  adoptFactoryImprovement,
  readFactoryImprovementAdoption,
} from "@/lib/factory-proposals/adoption-server";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { readFactoryImprovementPublication } from "@/lib/factory-proposals/publication-server";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 120;

type Context = {
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
const maxRequestBytes = 1024;

export async function GET(request: Request, context: Context) {
  return handleRequest(request, context, "read");
}

export async function POST(request: Request, context: Context) {
  if (!isSameOriginFactoryOAuthPost(request)) return failure("Send this request from Wallie.", 403);
  return handleRequest(request, context, "adopt");
}

async function handleRequest(request: Request, { params }: Context, action: "read" | "adopt") {
  if (new URL(request.url).search) return failure("Unexpected adoption query.", 400);
  try {
    const revision = revisionScope.safeParse(await params);
    if (!revision.success)
      return failure("Provide a valid improvement proposal and revision ID.", 400);
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const actorUserId = context.access.user.id;
    const scope = {
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId,
      ...revision.data,
      signal: request.signal,
    };
    if (action === "read") {
      const privilegedScope = { ...scope, client: createSupabaseAdminClient() };
      const [publication, adoption] = await Promise.all([
        readFactoryImprovementPublication(privilegedScope),
        readFactoryImprovementAdoption(privilegedScope),
      ]);
      return Response.json({ publication, adoption }, { headers });
    }

    const limit = await enforceRateLimit(
      "improvementProposals",
      `${context.workspaceId}:${actorUserId}`,
    );
    if (limit.response) {
      limit.response.headers.set("Cache-Control", headers["Cache-Control"]);
      return limit.response;
    }
    const raw = await readBoundedJsonBody(request, maxRequestBytes);
    if (!raw.ok) {
      if (raw.code === "unsupported_media_type")
        return failure("Send a JSON adoption command.", 415);
      if (raw.code === "request_too_large")
        return failure("The adoption command is too large.", 413);
      return failure("Send a valid adoption command.", 400);
    }
    const command = factoryImprovementAdoptionCommandSchema.safeParse(raw.body);
    if (!command.success) return failure("Send a valid adoption command.", 400);

    const result = await adoptFactoryImprovement(
      { ...scope, client: createSupabaseAdminClient() },
      command.data,
    );
    return Response.json(result, { status: result.replay ? 200 : 201, headers });
  } catch (error) {
    return adoptionFailure(error);
  }
}

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

function adoptionFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (
    code === "PT502" ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return failure(
      "Could not verify the reviewed merge with GitHub. Retry the same proposal revision.",
      502,
    );
  }
  switch (code) {
    case "42501":
      return failure("You do not have permission to adopt this improvement.", 403);
    case "P0002":
      return failure("The proposal revision or its publication is unavailable.", 404);
    case "P0011":
    case "PT409":
      return failure(
        "The proposal, active base, or reviewed merge changed. Reload and retry.",
        409,
      );
    case "22023":
    case "PT422":
      return failure(
        "Adoption requires qualified comparisons and a human-reviewed GitHub merge.",
        422,
      );
    default:
      return failure("Could not process improvement adoption.", 500);
  }
}
