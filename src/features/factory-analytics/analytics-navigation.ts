import type { AnalyticsQuery } from "./analytics-query";
import type { ScorerTrendQuery } from "@/lib/factory-evaluations/score-trend-query";

type Fields = Record<string, string | undefined>;

export function analyticsCoreFields(factoryId: string, query: AnalyticsQuery): Fields {
  return {
    factory: factoryId,
    from: query.from.slice(0, 10),
    to: query.to.slice(0, 10),
    compare: query.comparison ? "previous" : undefined,
    dimension: query.dimension,
    environment: query.environment ?? undefined,
    routingCanary: query.routingCanaryId,
    routingAlert: query.routingAlertId,
  };
}

export function analyticsEvidenceFields(evidence: AnalyticsQuery["evidence"]): Fields {
  return evidence ? { ...evidence } : {};
}

export function analyticsScorerFields(query: ScorerTrendQuery | null): Fields {
  if (!query) return {};
  return Object.fromEntries(
    Object.entries(query).filter(([key]) => key !== "from" && key !== "to"),
  );
}

export function applyAnalyticsFields(
  form: FormData,
  core: Fields,
  evidence: Fields,
  scorer: Fields,
) {
  const next = { ...core };
  for (const name of ["from", "to", "compare", "dimension", "environment"]) {
    next[name] = form.get(name)?.toString() || undefined;
  }
  const dateChanged = next.from !== core.from || next.to !== core.to;
  const dimensionChanged = next.dimension !== core.dimension;
  const environmentChanged = next.environment !== core.environment;
  const nextEvidence = { ...evidence };
  if (dateChanged || dimensionChanged || environmentChanged) delete nextEvidence.cursor;
  if (dimensionChanged && nextEvidence.metric === "throughput") delete nextEvidence.bucket;
  const nextScorer = { ...scorer };
  if (dateChanged) {
    delete nextScorer.scoreSnapshot;
    delete nextScorer.beforeRunFinishedAt;
    delete nextScorer.beforeScoreRun;
    delete nextScorer.evaluationDay;
  }
  return {
    ...next,
    ...(nextEvidence.period === "compare" && !next.compare ? {} : nextEvidence),
    ...nextScorer,
  };
}

export function analyticsFieldsHref(path: string, fields: Fields) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value || (value === "" && (key === "from" || key === "to"))) search.set(key, value);
  }
  return search.size ? path + "?" + search.toString() : path;
}
