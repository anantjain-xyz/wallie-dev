import { applyScorerGovernance } from "@/lib/factory-evaluations/scorer-governance";
import { scorerGovernanceCommandSchema } from "@/lib/factory-evaluations/scorer-governance-contracts";
import { handleScorerGovernanceCommand } from "@/lib/factory-evaluations/scorer-governance-http";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; scorerId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  return handleScorerGovernanceCommand(
    request,
    params,
    (await params).scorerId,
    scorerGovernanceCommandSchema,
    applyScorerGovernance,
  );
}
