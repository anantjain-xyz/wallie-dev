import { applyEvaluationGovernance } from "@/lib/factory-evaluations/scorer-governance";
import {
  evaluationGovernanceCommandSchema,
  type EvaluationGovernanceCommand,
} from "@/lib/factory-evaluations/scorer-governance-contracts";
import { handleScorerGovernanceCommand } from "@/lib/factory-evaluations/scorer-governance-http";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; attemptId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  return handleScorerGovernanceCommand<EvaluationGovernanceCommand>(
    request,
    params,
    (await params).attemptId,
    evaluationGovernanceCommandSchema,
    applyEvaluationGovernance,
  );
}
