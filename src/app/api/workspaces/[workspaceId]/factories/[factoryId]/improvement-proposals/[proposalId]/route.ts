import { resolveFactoryRouteContext } from "@/lib/factories/route-context";
import { factoryProposalUuidSchema } from "@/lib/factory-proposals/contracts";
import {
  factoryProposalError,
  factoryProposalFailure,
  factoryProposalResponse,
  readFactoryImprovementProposal,
} from "@/lib/factory-proposals/server";

type ProposalRoute = {
  params: Promise<{ workspaceId: string; factoryId: string; proposalId: string }>;
};

export async function GET(request: Request, { params }: ProposalRoute) {
  const proposal = factoryProposalUuidSchema.safeParse((await params).proposalId);
  const revisionIds = new URL(request.url).searchParams.getAll("revisionId");
  const revision = factoryProposalUuidSchema.optional().safeParse(revisionIds[0]);
  if (!proposal.success || !revision.success || revisionIds.length > 1) {
    return factoryProposalError(
      "Provide a valid improvement proposal and optional revision ID.",
      400,
    );
  }

  try {
    const context = await resolveFactoryRouteContext(params);
    if (!context.ok) return context.response;
    const receipt = await readFactoryImprovementProposal(
      {
        client: context.access.supabase,
        workspaceId: context.access.workspace.id,
        factoryId: context.factoryId,
        signal: request.signal,
      },
      proposal.data,
      revision.data,
    );
    return receipt
      ? factoryProposalResponse(receipt)
      : factoryProposalError("The improvement proposal is unavailable.", 404);
  } catch (error) {
    return factoryProposalFailure(error);
  }
}
