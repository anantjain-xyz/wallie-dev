import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { improvementPublicationTargetCommandSchema } from "@/lib/factory-proposals/publication-contracts";
import { setFactoryImprovementPublicationTarget } from "@/lib/factory-proposals/publication-server";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type Context = { params: Promise<{ workspaceId: string; factoryId: string }> };
const maxRequestBytes = 1024;

export async function POST(request: Request, { params }: Context) {
  if (!isSameOriginFactoryOAuthPost(request)) return failure("Send this request from Wallie.", 403);
  if (new URL(request.url).search) return failure("Unexpected publication target query.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const actorUserId = context.access.user.id;
    const limit = await enforceRateLimit(
      "improvementProposals",
      `${context.workspaceId}:${actorUserId}`,
    );
    if (limit.response) {
      limit.response.headers.set("Cache-Control", headers["Cache-Control"]);
      return limit.response;
    }

    const raw = await readBoundedJsonBody(request, maxRequestBytes);
    if (!raw.ok && raw.code === "request_too_large") {
      return failure("The publication target request is too large.", 413);
    }
    if (!raw.ok && raw.code === "unsupported_media_type") {
      return failure("Send the publication target as JSON.", 415);
    }
    const command = improvementPublicationTargetCommandSchema.safeParse(raw.ok ? raw.body : null);
    if (!command.success) return failure("Provide the definition repository and base branch.", 400);

    const target = await setFactoryImprovementPublicationTarget(
      {
        client: createSupabaseAdminClient(),
        workspaceId: context.workspaceId,
        factoryId: context.factoryId,
        actorUserId,
        signal: request.signal,
      },
      command.data,
    );
    return Response.json({ target }, { headers });
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    if (
      code === "PT502" ||
      (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    ) {
      return failure("Could not confirm the publication target.", 502);
    }
    if (code === "PT422" || code === "22023") {
      return failure("Choose an active factory repository and a dedicated base branch.", 422);
    }
    return failure("Could not configure the publication target.", factoryErrorStatus(code));
  }
}

function failure(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}
