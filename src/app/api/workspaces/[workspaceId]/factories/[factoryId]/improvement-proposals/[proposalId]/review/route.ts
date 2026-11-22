import { factoryResponseHeaders, resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import { factoryProposalError, factoryProposalFailure } from "@/lib/factory-proposals/server";
import { saveImprovementReview } from "@/lib/factory-proposals/workbench";
import { proposalReviewCommandSchema } from "@/lib/factory-proposals/workbench-contracts";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { enforceRateLimit } from "@/lib/rate-limit";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type ReviewRoute = {
  params: Promise<{ workspaceId: string; factoryId: string; proposalId: string }>;
};

export async function POST(request: Request, { params }: ReviewRoute) {
  if (!isSameOriginFactoryOAuthPost(request))
    return factoryProposalError("Send this request from Wallie.", 403);
  const proposalId = factoryProposalUuidSchema.safeParse((await params).proposalId);
  if (!proposalId.success)
    return factoryProposalError("Provide a valid improvement proposal ID.", 400);

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const limit = await enforceRateLimit(
      "improvementProposals",
      `${context.access.workspace.id}:${context.access.user.id}`,
    );
    if (limit.response) return limit.response;

    const body = await readBoundedJsonBody(request, 32 * 1024);
    if (!body.ok) {
      switch (body.code) {
        case "request_too_large":
          return factoryProposalError("The improvement review is too large.", 413);
        case "unsupported_media_type":
          return factoryProposalError("Send the improvement review as JSON.", 415);
        case "invalid_request":
          return factoryProposalError("Provide a valid JSON improvement review.", 400);
      }
    }
    const command = proposalReviewCommandSchema.safeParse(body.body);
    if (!command.success) return factoryProposalError("Check the improvement review fields.", 400);

    const saved = await saveImprovementReview(
      createSupabaseAdminClient(),
      context,
      context.access.user.id,
      proposalId.data,
      command.data,
      request.signal,
    );
    return Response.json(saved, {
      status: saved.replay ? 200 : 201,
      headers: factoryResponseHeaders,
    });
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "PT409") {
      return factoryProposalError(
        "The proposal revision or discussion changed. Reload before reviewing.",
        409,
      );
    }
    return factoryProposalFailure(error);
  }
}
