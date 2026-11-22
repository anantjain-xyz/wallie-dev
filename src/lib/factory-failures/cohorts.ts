import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  failureCohortDetailSchema,
  failureCohortListSchema,
  failureCohortReviewResultSchema,
  type FailureCohortQuery,
  type FailureCohortReview,
} from "./cohort-contracts";

type Client = SupabaseClient<Database>;
type Scope = { workspaceId: string; factoryId: string };

export async function listFailureCohorts(client: Client, scope: Scope, query: FailureCohortQuery) {
  const { data, error } = await client.rpc("list_factory_failure_cohorts", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_limit: 25,
    p_after_cohort_id: query.after,
    p_symptom_kind: query.symptom,
    p_definition_revision_id: query.revision,
    p_disposition: query.disposition,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  return failureCohortListSchema.parse(data);
}

export async function getFailureCohort(
  client: Client,
  scope: Scope,
  cohortId: string,
  query: Pick<FailureCohortQuery, "after" | "revision">,
) {
  const { data, error } = await client.rpc("get_factory_failure_cohort", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_cohort_id: cohortId,
    p_limit: 25,
    p_after_member_id: query.after,
    p_definition_revision_id: query.revision,
  });
  if (error?.code === "P0002") return null;
  if (error) throw error;
  return failureCohortDetailSchema.parse(data);
}

export async function reviewFailureCohort(
  client: Client,
  scope: Scope,
  cohortId: string,
  command: FailureCohortReview,
) {
  const { data, error } = await client.rpc("review_factory_failure_cohort", {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_cohort_id: cohortId,
    p_expected_review_revision: command.expectedRevision,
    p_request_id: command.requestId,
    p_action: command.action,
    p_label: command.action === "label" ? command.label : undefined,
    p_selected_run_ids: command.action === "split" ? command.selectedRunIds : undefined,
    p_expected_membership_digest: command.action === "split" ? command.membershipDigest : undefined,
  });
  if (error) throw error;
  return failureCohortReviewResultSchema.parse(data);
}

export async function listRecentFailureDefinitionRevisions(client: Client, scope: Scope) {
  const { data, error } = await client
    .from("factory_definition_revisions")
    .select("id, canonical_digest, created_at")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(30);
  if (error) throw error;
  return data;
}
