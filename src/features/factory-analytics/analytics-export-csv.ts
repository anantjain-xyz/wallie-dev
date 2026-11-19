import "server-only";

import { z } from "zod";

import { analyticsDimensionSchema } from "./analytics-query";

export const MAX_ANALYTICS_EXPORT_JSON_BYTES = 1_048_576;
const MAX_CSV_BYTES = 3_145_728;
const MAX_ROWS_BY_METRIC = 100;
const MAX_TOTAL_EVIDENCE_ROWS = 800;

const id = z.string().uuid();
const instant = z.string().datetime({ offset: true });
const record = z.record(z.unknown());
const observations = z.array(record).max(MAX_ROWS_BY_METRIC);
const windowSchema = z.object({ from: instant, to: instant });
const periodSchema = z.object({
  key: z.enum(["primary", "comparison"]),
  window: windowSchema,
  summaries: z.object({ flow: record, cost: record, throughput: record, revert: record }),
  rolesVisibility: z.enum(["full", "redacted"]),
  evidence: z.object({
    flow: observations,
    merge: observations,
    deployment: observations,
    deliveryCost: observations,
    operatingCost: observations,
    costMerges: observations,
    throughput: observations,
    revert: observations,
  }),
});
const snapshotSchema = z.object({
  schemaVersion: z.literal(1),
  id,
  workspaceId: id,
  factoryId: id,
  capturedAt: instant,
  expiresAt: instant,
  filters: windowSchema.extend({
    dimension: analyticsDimensionSchema,
    deploymentEnvironment: z.string().nullable(),
    comparePrevious: z.boolean(),
  }),
  periods: z.array(periodSchema).min(1).max(2),
});

type Snapshot = z.infer<typeof snapshotSchema>;
type SnapshotScope = { exportId: string; workspaceId: string; factoryId: string };

// The Node runtime exposes the original scalar in the JSON reviver. Preserve database
// numerics that IEEE 754 would round, including cost ratios, in the CSV record cells.
const rawJson: unknown = Reflect.get(JSON, "rawJSON");

export function parseAnalyticsExportSnapshot(
  source: string,
  scope: SnapshotScope,
): Snapshot | null {
  if (Buffer.byteLength(source, "utf8") > MAX_ANALYTICS_EXPORT_JSON_BYTES) return null;
  try {
    const decoded: unknown = JSON.parse(
      source,
      (_key, value: unknown, context?: { source: string }): unknown => {
        if (typeof value !== "number" || !context || String(value) === context.source) return value;
        if (typeof rawJson !== "function") throw new Error("Exact JSON numerics are unavailable.");
        return rawJson(context.source);
      },
    );
    const parsed = snapshotSchema.safeParse(decoded);
    if (!parsed.success) return null;
    const snapshot = parsed.data;
    if (
      snapshot.id !== scope.exportId.toLowerCase() ||
      snapshot.workspaceId !== scope.workspaceId.toLowerCase() ||
      snapshot.factoryId !== scope.factoryId.toLowerCase() ||
      snapshot.periods[0]?.key !== "primary" ||
      snapshot.periods.some((period, index) => index === 1 && period.key !== "comparison") ||
      (snapshot.periods.length === 2) !== snapshot.filters.comparePrevious
    )
      return null;
    const totalRows = snapshot.periods
      .flatMap(({ evidence }) => Object.values(evidence))
      .reduce((total, rows) => total + rows.length, 0);
    return totalRows <= MAX_TOTAL_EVIDENCE_ROWS ? snapshot : null;
  } catch {
    return null;
  }
}

const columns = [
  "schema_version",
  "snapshot_id",
  "workspace_id",
  "factory_id",
  "captured_at",
  "expires_at",
  "period",
  "from_inclusive",
  "to_exclusive",
  "throughput_dimension",
  "deployment_environment",
  "compare_previous",
  "roles_visibility",
  "record_type",
  "metric",
  "metric_revision",
  "session_id",
  "run_id",
  "merge_id",
  "observation_id",
  "source_state",
  "elapsed_seconds",
  "cost_usd",
  "record_json",
];

function csvCell(text: string) {
  const safe = /^[\s\u0000-\u001f]*[=+@-]|^[\t\r\n]/u.test(text) ? "'" + text : text;
  return '"' + safe.replaceAll('"', '""') + '"';
}

function textField(data: Record<string, unknown>, ...fields: string[]) {
  for (const field of fields) {
    const value = data[field];
    if (typeof value === "string") return value;
  }
  return "";
}

function numericCell(value: unknown) {
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";
  const source = JSON.stringify(value);
  return /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(source) ? source : "";
}

function property(value: unknown, key: string): unknown {
  return value && typeof value === "object"
    ? Object.getOwnPropertyDescriptor(value, key)?.value
    : undefined;
}

export function serializeAnalyticsExportCsv(snapshot: Snapshot): string | null {
  const lines = [columns.join(",") + "\r\n"];
  let bytes = Buffer.byteLength(lines[0] ?? "", "utf8");
  const { filters } = snapshot;
  for (const period of snapshot.periods) {
    const prefix = [
      String(snapshot.schemaVersion),
      snapshot.id,
      snapshot.workspaceId,
      snapshot.factoryId,
      snapshot.capturedAt,
      snapshot.expiresAt,
      period.key,
      period.window.from,
      period.window.to,
      filters.dimension,
      filters.deploymentEnvironment ?? "",
      String(filters.comparePrevious),
      period.rolesVisibility,
    ];
    const flow = period.summaries.flow.metricRevisions;
    const costs = period.summaries.cost.costs;
    const revisions = new Map<string, unknown>([
      ["flow", property(flow, "workflow_flow")],
      ["merge", property(flow, "request_to_merge")],
      ["deployment", property(flow, "request_to_deployment")],
      ["deliveryCost", property(property(costs, "delivery"), "metricRevision")],
      ["operatingCost", property(property(costs, "operating"), "metricRevision")],
      ["throughput", period.summaries.throughput.metricRevision],
      ["revert", period.summaries.revert.metricRevision],
    ]);
    const batches = [
      ...Object.entries(period.summaries).map(([metric, row]) => ({
        metric,
        type: "summary",
        rows: [row],
      })),
      ...Object.entries(period.evidence).map(([metric, rows]) => ({
        metric,
        type: "observation",
        rows,
      })),
    ];
    for (const { metric, type, rows } of batches) {
      const revision = revisions.get(metric);
      for (const row of rows) {
        const line =
          [
            ...prefix,
            type,
            metric,
            typeof revision === "number" ? String(revision) : "",
            textField(row, "sessionId", "session_id"),
            textField(row, "runId", "run_id"),
            textField(row, "mergeId", "merge_id", "canonicalMergeId", "originalMergeId"),
            textField(
              row,
              "deploymentObservationId",
              "mergeObservationId",
              "merge_observation_id",
              "originalObservationId",
              "requestObservationId",
            ),
            textField(row, "cost_state", "status", "bucketKey"),
            numericCell(row.seconds),
            numericCell(row.cost_usd),
            JSON.stringify(row),
          ]
            .map(csvCell)
            .join(",") + "\r\n";
        bytes += Buffer.byteLength(line, "utf8");
        if (bytes > MAX_CSV_BYTES) return null;
        lines.push(line);
      }
    }
  }
  return lines.join("");
}
