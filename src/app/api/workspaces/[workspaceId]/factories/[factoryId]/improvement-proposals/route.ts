import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { isSameOriginFactoryOAuthPost } from "@/lib/factory-oauth/browser-auth";
import { factoryProposalCommandSchema } from "@/lib/factory-proposals/contracts";
import {
  factoryProposalError,
  factoryProposalFailure,
  factoryProposalResponse,
  saveFactoryImprovementProposal,
} from "@/lib/factory-proposals/server";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type ProposalRoute = { params: Promise<{ workspaceId: string; factoryId: string }> };
const maximumRequestBytes = 64 * 1024;

export async function POST(request: Request, { params }: ProposalRoute) {
  if (!isSameOriginFactoryOAuthPost(request)) {
    return factoryProposalError("Send this request from Wallie.", 403);
  }

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;

    const body = await readBoundedJsonBody(request, maximumRequestBytes);
    if (!body.ok) {
      switch (body.code) {
        case "request_too_large":
          return factoryProposalError("The improvement proposal is too large.", 413);
        case "unsupported_media_type":
          return factoryProposalError("Send the improvement proposal as JSON.", 415);
        case "invalid_request":
          return factoryProposalError("Provide a valid JSON improvement proposal.", 400);
      }
    }
    const command = factoryProposalCommandSchema.safeParse(body.body);
    if (!command.success) {
      return factoryProposalError("Check the improvement proposal fields.", 400);
    }

    const saved = await saveFactoryImprovementProposal(
      {
        client: createSupabaseAdminClient(),
        workspaceId: context.access.workspace.id,
        factoryId: context.factoryId,
        signal: request.signal,
      },
      context.access.user.id,
      command.data,
    );
    return factoryProposalResponse(saved.proposal, saved.replay ? 200 : 201);
  } catch (error) {
    return factoryProposalFailure(error);
  }
}
