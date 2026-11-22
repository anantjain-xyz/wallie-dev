import "server-only";

import { isDeepStrictEqual } from "node:util";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import {
  factoryImprovementValidationReceiptSchema,
  type FactoryImprovementValidationCommand,
  type FactoryImprovementValidationReceipt,
} from "./validation-contracts";

type ValidationScope = {
  client: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  actorUserId: string;
  proposalId: string;
  proposalRevisionId: string;
  signal: AbortSignal;
};

const startReceipt = z.object({
  validation: factoryImprovementValidationReceiptSchema,
  replay: z.boolean(),
});

function validationArguments(scope: ValidationScope) {
  return {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
    p_proposal_id: scope.proposalId,
    p_proposal_revision_id: scope.proposalRevisionId,
  };
}

function matchesScope(receipt: FactoryImprovementValidationReceipt, scope: ValidationScope) {
  return (
    receipt.proposalId === scope.proposalId &&
    receipt.proposalRevisionId === scope.proposalRevisionId
  );
}

export async function startFactoryImprovementValidation(
  scope: ValidationScope,
  command: FactoryImprovementValidationCommand,
) {
  const { data, error } = await scope.client
    .rpc("start_factory_improvement_validation", {
      ...validationArguments(scope),
      p_request_id: command.requestId,
      p_targeted_suite_revision_id: command.targetedSuiteRevisionId,
      p_holdout_suite_revision_id: command.holdoutSuiteRevisionId,
      p_policy_revision_id: command.policyRevisionId,
      p_scorer_revision_id: command.scorerRevisionId,
      p_targeted_candidates: command.candidates,
      p_holdout_candidates: command.candidates,
      p_execution: command.execution,
      p_thresholds: command.thresholds,
    })
    .abortSignal(scope.signal);
  if (error) throw error;
  const result = startReceipt.parse(data);
  const { validation } = result;
  if (
    !matchesScope(validation, scope) ||
    validation.requestId !== command.requestId ||
    validation.targeted.suiteRevisionId !== command.targetedSuiteRevisionId ||
    validation.holdout.suiteRevisionId !== command.holdoutSuiteRevisionId ||
    validation.policyRevisionId !== command.policyRevisionId ||
    validation.scorerRevisionId !== command.scorerRevisionId ||
    !isDeepStrictEqual(validation.axes, command.candidates) ||
    !isDeepStrictEqual(validation.thresholds, command.thresholds) ||
    !isDeepStrictEqual(validation.execution, command.execution)
  ) {
    throw new Error("The validation receipt does not match the requested comparison.");
  }
  return result;
}

export async function readFactoryImprovementValidation(scope: ValidationScope) {
  const { data, error } = await scope.client
    .rpc("get_factory_improvement_validation", validationArguments(scope))
    .abortSignal(scope.signal);
  if (error) throw error;
  if (data === null) return null;
  const receipt = factoryImprovementValidationReceiptSchema.parse(data);
  if (!matchesScope(receipt, scope)) {
    throw new Error("The validation receipt does not match the requested proposal revision.");
  }
  return receipt;
}
