import { z } from "zod";

import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import {
  publishFactoryImprovement,
  readFactoryImprovementPublication,
} from "@/lib/factory-proposals/publication-server";
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

export async function GET(request: Request, context: Context) {
  return handleRequest(request, context, "read");
}

export async function POST(request: Request, context: Context) {
  if (!isSameOriginFactoryOAuthPost(request)) return failure("Send this request from Wallie.", 403);
  return handleRequest(request, context, "publish");
}

async function handleRequest(request: Request, { params }: Context, action: "read" | "publish") {
  if (new URL(request.url).search) return failure("Unexpected publication query.", 400);
  try {
    const revision = revisionScope.safeParse(await params);
    if (!revision.success)
      return failure("Provide a valid improvement proposal and revision ID.", 400);
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const actorUserId = context.access.user.id;

    if (action === "publish") {
      const limit = await enforceRateLimit(
        "improvementProposals",
        `${context.workspaceId}:${actorUserId}`,
      );
      if (limit.response) {
        limit.response.headers.set("Cache-Control", headers["Cache-Control"]);
        return limit.response;
      }
      if (await hasRequestBody(request))
        return failure("Send publication requests without a body.", 400);
    }

    const scope = {
      client: createSupabaseAdminClient(),
      workspaceId: context.workspaceId,
      factoryId: context.factoryId,
      actorUserId,
      ...revision.data,
      signal: request.signal,
    };
    if (action === "read") {
      const publication = await readFactoryImprovementPublication(scope);
      return publication
        ? Response.json({ publication }, { headers })
        : failure("No publication is available for this proposal revision.", 404);
    }

    const result = await publishFactoryImprovement(scope);
    const status = result.state === "pending" ? 202 : result.replay ? 200 : 201;
    return Response.json(result, { status, headers });
  } catch (error) {
    return publicationFailure(error);
  }
}

async function hasRequestBody(request: Request) {
  const length = request.headers.get("Content-Length");
  if (length !== null && !/^0+$/.test(length)) return true;

  const reader = request.body?.getReader();
  if (!reader) return false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return false;
      if (chunk.value.byteLength > 0) {
        void reader.cancel().catch(() => undefined);
        return true;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

function publicationFailure(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  if (
    code === "PT502" ||
    (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
  ) {
    return failure(
      "Could not confirm publication with GitHub. Retry the same proposal revision.",
      502,
    );
  }
  switch (code) {
    case "42501":
      return failure("Only a factory manager can access improvement publication.", 403);
    case "P0002":
      return failure("The proposal revision or its publication is unavailable.", 404);
    case "P0011":
    case "PT409":
      return failure(
        "The proposal, active base, or publication identity changed. Reload and retry.",
        409,
      );
    case "22023":
    case "PT422":
      return failure(
        "Publication requires a dedicated repository target and qualified comparisons.",
        422,
      );
    default:
      return failure("Could not process improvement publication.", 500);
  }
}
