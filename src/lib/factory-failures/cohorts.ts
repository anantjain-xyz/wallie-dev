import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  failureCohortDetailSchema,
  failureCohortListSchema,
  failureCohortReviewResultSchema,
  type FailureCohortQuery,
  type FailureCohortReview,
  type FailureRevisionOption,
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
  query: Pick<FailureCohortQuery, "after" | "revision"> & {
    runSearch?: string;
    observedOn?: string;
    memberId?: string;
  },
) {
  const args = {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_cohort_id: cohortId,
    p_limit: query.memberId ? 1 : 25,
    p_after_member_id: query.after,
    p_definition_revision_id: query.revision,
    p_run_search: query.runSearch || undefined,
    p_observed_on: query.observedOn,
    p_member_id: query.memberId,
  };
  const { data, error } = await client.rpc("get_factory_failure_cohort", args);
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

export async function loadFailureAgentNames(client: Client, scope: Scope, agentIds: string[]) {
  if (!agentIds.length) return new Map<string, string>();
  const { data, error } = await client
    .from("factory_agents")
    .select("id, name")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .in("id", [...new Set(agentIds)]);
  if (error) throw error;
  return new Map(data.map(({ id, name }) => [id, name]));
}

const revisionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });
const revisionPageSize = 20;

function revisionQuery(client: Client, scope: Scope) {
  return client
    .from("factory_definition_revisions")
    .select("id, canonical_digest, created_at, factory_definition_activations(activation_number)")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .order("activation_number", { referencedTable: "factory_definition_activations" })
    .limit(1, { referencedTable: "factory_definition_activations" });
}

export async function loadFailureActivation(client: Client, scope: Scope) {
  const { data, error } = await client
    .from("factory_definition_activations")
    .select("revision_id")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .order("activation_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data?.revision_id;
}

function revisionOption(
  row: {
    id: string;
    canonical_digest: string;
    created_at: string;
    factory_definition_activations: { activation_number: number }[];
  },
  active: string | undefined,
): FailureRevisionOption {
  const first = row.factory_definition_activations[0]?.activation_number;
  return {
    id: row.id,
    label: first == null ? "Historical revision" : `Factory revision · Activation ${first}`,
    detail: `${revisionDate.format(new Date(row.created_at))} · ${row.id === active ? "Active" : "Historical"} · ${row.canonical_digest.slice(0, 10)}`,
  };
}

export async function loadFailureRevisionOptions(
  client: Client,
  scope: Scope,
  ids: string[],
  active: string | undefined,
) {
  if (!ids.length) return new Map<string, FailureRevisionOption>();
  const { data, error } = await revisionQuery(client, scope).in("id", [...new Set(ids)]);
  if (error) throw error;
  return new Map(data.map((row) => [row.id, revisionOption(row, active)]));
}

export async function listFailureRevisionPage(
  client: Client,
  scope: Scope,
  active: string | undefined,
  before?: string,
) {
  const query = revisionQuery(client, scope)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(revisionPageSize + 1);
  if (before) {
    const { data, error } = await client
      .from("factory_definition_revisions")
      .select("id, created_at")
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .eq("id", before)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    query.or(
      `created_at.lt.${data.created_at},and(created_at.eq.${data.created_at},id.lt.${data.id})`,
    );
  }
  const { data, error } = await query;
  if (error) throw error;
  const rows = data.slice(0, revisionPageSize);
  return {
    options: rows.map((row) => revisionOption(row, active)),
    next: data.length > revisionPageSize ? (rows.at(-1)?.id ?? null) : null,
  };
}
