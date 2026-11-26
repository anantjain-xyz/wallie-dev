import "server-only";

import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

import type { AnalyticsEvidence, AnalyticsPeriodData } from "./analytics-data";

type Scope = Pick<AuthenticatedWorkspaceContext, "supabase"> & {
  workspaceId: string;
  factoryId: string;
};

export type AnalyticsLabels = {
  buckets: ReadonlyMap<string, string>;
  runStages: ReadonlyMap<string, string>;
};

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" });

export function throughputLabel(
  labels: AnalyticsLabels["buckets"],
  dimension: string,
  key: string,
  recordedLabel: string,
) {
  if (dimension === "person" && (key.startsWith("member:") || key.startsWith("service:"))) {
    return (
      labels.get(key) ??
      (key.startsWith("member:")
        ? "Name not available · Workspace member"
        : "Name not available · Service principal")
    );
  }
  if (dimension === "definition") {
    if (uuid.test(key)) return labels.get(key) ?? "Definition revision details unavailable";
    if (key === "unknown") return "Definition revision unknown";
  }
  return recordedLabel;
}

async function labelRows<T>(
  request: PromiseLike<{ data: T[] | null; error: unknown }>,
): Promise<T[]> {
  try {
    const { data, error } = await request;
    return error ? [] : (data ?? []);
  } catch {
    return [];
  }
}

async function scopedChunks<T>(ids: Set<string>, read: (batch: string[]) => Promise<T[]>) {
  const batches: string[][] = [];
  for (const id of ids) {
    const batch = batches.at(-1);
    if (batch && batch.length < 100) batch.push(id);
    else batches.push([id]);
  }
  return (await Promise.all(batches.map(read))).flat();
}

export async function loadAnalyticsLabels(
  { supabase, workspaceId, factoryId }: Scope,
  periods: (AnalyticsPeriodData | null)[],
  evidence: AnalyticsEvidence | null,
): Promise<AnalyticsLabels> {
  const memberIds = new Set<string>();
  const serviceIds = new Set<string>();
  const revisionIds = new Set<string>();
  const runIds = new Set<string>();

  for (const period of periods) {
    if (period?.throughput.status !== "ready") continue;
    const { buckets, dimension } = period.throughput.data;
    for (const { key } of buckets) {
      if (dimension === "person" && key.startsWith("member:") && uuid.test(key.slice(7)))
        memberIds.add(key.slice(7));
      if (dimension === "person" && key.startsWith("service:") && uuid.test(key.slice(8)))
        serviceIds.add(key.slice(8));
      if (dimension === "definition" && uuid.test(key)) revisionIds.add(key);
    }
  }
  if (evidence?.metric === "throughput") {
    for (const row of evidence.items) {
      if (row.invokingActorMemberId) memberIds.add(row.invokingActorMemberId);
      if (row.invokingActorServicePrincipalId) serviceIds.add(row.invokingActorServicePrincipalId);
      if (row.definitionRevisionId) revisionIds.add(row.definitionRevisionId);
    }
  }
  for (const row of evidence?.items ?? []) {
    if ("runId" in row && row.runId) runIds.add(row.runId);
    if ("observations" in row)
      for (const observation of row.observations ?? []) {
        if (observation.runId) runIds.add(observation.runId);
      }
  }

  const sessionIds = Object.keys(evidence?.sessionNumbers ?? {});
  const [members, services, revisions, runs] = await Promise.all([
    scopedChunks(memberIds, (ids) =>
      labelRows(
        supabase
          .from("workspace_members")
          .select("id, full_name, username, role, is_active")
          .eq("workspace_id", workspaceId)
          .in("id", ids),
      ),
    ),
    scopedChunks(serviceIds, (ids) =>
      labelRows(
        supabase
          .from("service_principals")
          .select("id, name")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", ids),
      ),
    ),
    scopedChunks(revisionIds, (ids) =>
      labelRows(
        supabase
          .from("factory_definition_revisions")
          .select("id, created_at, factory_definition_activations(activation_number, created_at)")
          .eq("workspace_id", workspaceId)
          .eq("factory_id", factoryId)
          .in("id", ids)
          .order("activation_number", { referencedTable: "factory_definition_activations" })
          .limit(1, { referencedTable: "factory_definition_activations" }),
      ),
    ),
    sessionIds.length
      ? scopedChunks(runIds, (ids) =>
          labelRows(
            supabase
              .from("agent_runs")
              .select("id, stage_name, stage_slug")
              .eq("workspace_id", workspaceId)
              .in("session_id", sessionIds)
              .in("id", ids),
          ),
        )
      : [],
  ]);

  const buckets = new Map<string, string>();
  for (const member of members) {
    const name = member.full_name?.trim() || member.username?.trim();
    buckets.set(
      `member:${member.id}`,
      member.is_active
        ? `${name || "Name not available"} · ${member.role.charAt(0).toUpperCase() + member.role.slice(1)}`
        : "Former member",
    );
  }
  for (const service of services) {
    buckets.set(`service:${service.id}`, `${service.name} · Service principal`);
  }
  for (const revision of revisions) {
    const firstActivation = revision.factory_definition_activations[0];
    buckets.set(
      revision.id,
      firstActivation
        ? `Definition revision · First activated as #${firstActivation.activation_number} · ${date.format(new Date(firstActivation.created_at))} UTC`
        : `Definition revision · Created ${date.format(new Date(revision.created_at))} UTC`,
    );
  }
  const runStages = new Map<string, string>();
  for (const run of runs) {
    const stage = run.stage_name || run.stage_slug;
    if (stage) runStages.set(run.id, stage);
  }
  return { buckets, runStages };
}
