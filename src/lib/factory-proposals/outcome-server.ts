import "server-only";

import { factoryImprovementOutcomesSchema } from "./outcome-contracts";
import {
  normalizedPublicationScope,
  proposalArguments,
  type PublicationScope,
} from "./publication-server";

export async function readFactoryImprovementOutcomes(input: PublicationScope) {
  const scope = normalizedPublicationScope(input);
  const { data, error } = await scope.client
    .rpc("get_factory_improvement_outcomes", proposalArguments(scope))
    .abortSignal(scope.signal);
  if (error) throw error;
  return data === null ? null : factoryImprovementOutcomesSchema.parse(data);
}
