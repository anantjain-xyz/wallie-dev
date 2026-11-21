import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";

import type { Database } from "@/lib/supabase/database.types";

import {
  benchmarkComparisonExportListSchema,
  benchmarkComparisonExportManifestSchema,
  benchmarkComparisonExportPageSchema,
  benchmarkComparisonExportReceiptSchema,
  benchmarkComparisonListSchema,
  benchmarkComparisonSchema,
  MAX_BENCHMARK_COMPARISON_EXPORT_MANIFEST_BYTES,
  MAX_BENCHMARK_COMPARISON_EXPORT_PAGE_BYTES,
  type BenchmarkComparisonExportPart,
  type benchmarkComparisonExportListQuerySchema,
  type benchmarkComparisonListQuerySchema,
  type benchmarkComparisonQuerySchema,
} from "./comparison-contracts";

export type BenchmarkComparisonFactoryScope = {
  admin: SupabaseClient<Database>;
  workspaceId: string;
  factoryId: string;
  actorUserId: string;
  signal?: AbortSignal;
};

export type BenchmarkComparisonScope = BenchmarkComparisonFactoryScope & {
  experimentId: string;
};

type ComparisonErrorStatus = 400 | 403 | 404 | 409 | 410 | 429;

export class BenchmarkComparisonError extends Error {
  constructor(
    readonly status: ComparisonErrorStatus,
    message: string,
  ) {
    super(message);
    this.name = "BenchmarkComparisonError";
  }
}

function scopeArgs(scope: BenchmarkComparisonFactoryScope) {
  return {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.actorUserId,
  };
}

function experimentArgs(scope: BenchmarkComparisonScope) {
  return { ...scopeArgs(scope), p_experiment_id: scope.experimentId };
}

type RpcResult = { data: unknown; error: { code: string } | null };
type ComparisonRpc = PromiseLike<RpcResult> & {
  abortSignal: (signal: AbortSignal) => PromiseLike<RpcResult>;
};

async function readRpc(query: ComparisonRpc, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  signal?.throwIfAborted();
  if (!error) return data;

  switch (error.code) {
    case "22023":
      throw new BenchmarkComparisonError(400, "Provide a valid page or export cursor.");
    case "42501":
      throw new BenchmarkComparisonError(403, "Factory manager access is required.");
    case "P0002":
      throw new BenchmarkComparisonError(404, "The benchmark comparison or export is unavailable.");
    case "PT409":
      throw new BenchmarkComparisonError(409, "The benchmark export request could not be reused.");
    case "PT410":
      throw new BenchmarkComparisonError(410, "The benchmark export expired.");
    case "PT429":
      throw new BenchmarkComparisonError(429, "The factory has too many active benchmark exports.");
    default:
      throw new Error("The benchmark comparison service could not complete the request.");
  }
}

export async function listBenchmarkComparisons(
  scope: BenchmarkComparisonFactoryScope,
  query: z.output<typeof benchmarkComparisonListQuerySchema> = {},
) {
  const limit = query.limit ?? 24;
  const data = await readRpc(
    scope.admin.rpc("list_factory_benchmark_comparisons", {
      ...scopeArgs(scope),
      ...(query.suiteRevisionId ? { p_suite_revision_id: query.suiteRevisionId } : {}),
      ...(query.beforeCreatedAt && query.beforeExperimentId
        ? {
            p_before_created_at: query.beforeCreatedAt,
            p_before_experiment_id: query.beforeExperimentId,
          }
        : {}),
      p_limit: limit,
    }),
    scope.signal,
  );
  const page = benchmarkComparisonListSchema.parse(data);
  const lastItem = page.items.at(-1);
  if (
    page.items.length > limit ||
    (query.suiteRevisionId &&
      page.items.some(({ suite }) => suite.revisionId !== query.suiteRevisionId)) ||
    (page.nextCursor &&
      (page.nextCursor.experimentId !== lastItem?.experimentId ||
        page.nextCursor.createdAt !== lastItem.createdAt))
  ) {
    throw new Error("The comparison list did not match the requested page.");
  }
  return page;
}

export async function readBenchmarkComparison(
  scope: BenchmarkComparisonScope,
  query: z.output<typeof benchmarkComparisonQuerySchema> = {},
) {
  const limit = query.limit ?? 50;
  const candidateLimit = query.candidateLimit ?? 50;
  const data = await readRpc(
    scope.admin.rpc("read_factory_benchmark_comparison", {
      ...experimentArgs(scope),
      ...(query.afterTrialId ? { p_after_trial_id: query.afterTrialId } : {}),
      p_limit: limit,
      ...(query.afterCandidateKey ? { p_after_candidate_key: query.afterCandidateKey } : {}),
      p_candidate_limit: candidateLimit,
    }),
    scope.signal,
  );
  const page = benchmarkComparisonSchema.parse(data);
  if (
    page.experimentId !== scope.experimentId ||
    page.trialRows.length > limit ||
    page.trialRows.some(({ trialId }) => trialId === query.afterTrialId) ||
    page.candidates.length > candidateLimit ||
    page.candidates.some(({ candidateKey }) => candidateKey === query.afterCandidateKey) ||
    (!query.afterCandidateKey &&
      !page.nextCandidateCursor &&
      page.candidates.length !== page.candidateCount)
  ) {
    throw new Error("The comparison did not match the requested experiment and page.");
  }
  return page;
}

export async function listBenchmarkComparisonExports(
  scope: BenchmarkComparisonScope,
  query: z.output<typeof benchmarkComparisonExportListQuerySchema> = {},
) {
  const limit = query.limit ?? 20;
  const data = await readRpc(
    scope.admin.rpc("list_factory_benchmark_comparison_exports", {
      ...experimentArgs(scope),
      ...(query.beforeCapturedAt && query.beforeExportId
        ? {
            p_before_captured_at: query.beforeCapturedAt,
            p_before_export_id: query.beforeExportId,
          }
        : {}),
      p_limit: limit,
    }),
    scope.signal,
  );
  const page = benchmarkComparisonExportListSchema.parse(data);
  const lastItem = page.items.at(-1);
  if (
    page.experimentId !== scope.experimentId ||
    page.items.length > limit ||
    (page.nextCursor &&
      (page.nextCursor.exportId !== lastItem?.exportId ||
        page.nextCursor.capturedAt !== lastItem.capturedAt))
  ) {
    throw new Error("The comparison exports did not match the requested experiment and page.");
  }
  return page;
}

export async function createBenchmarkComparisonExport(
  scope: BenchmarkComparisonScope,
  requestId: string,
) {
  return benchmarkComparisonExportReceiptSchema.parse(
    await readRpc(
      scope.admin.rpc("create_factory_benchmark_comparison_export", {
        ...experimentArgs(scope),
        p_request_id: requestId,
      }),
      scope.signal,
    ),
  );
}

export async function readBenchmarkComparisonExport(
  scope: BenchmarkComparisonScope,
  exportId: string,
  part?: BenchmarkComparisonExportPart,
) {
  const data = await readRpc(
    scope.admin.rpc("read_factory_benchmark_comparison_export", {
      ...experimentArgs(scope),
      p_export_id: exportId,
      ...(part ? { p_page_ordinal: part.ordinal, p_page_kind: part.kind } : {}),
    }),
    scope.signal,
  );
  if (typeof data !== "string") throw new Error("The comparison export has no retained JSON.");
  const maxBytes = part
    ? MAX_BENCHMARK_COMPARISON_EXPORT_PAGE_BYTES
    : MAX_BENCHMARK_COMPARISON_EXPORT_MANIFEST_BYTES;
  if (Buffer.byteLength(data, "utf8") > maxBytes) {
    throw new Error("The retained comparison export exceeds its byte limit.");
  }

  // Validate at the boundary and serve the stored bytes used for page digests.
  const body: unknown = JSON.parse(data);
  if (!part) {
    const manifest = benchmarkComparisonExportManifestSchema.parse(body);
    if (
      manifest.workspaceId !== scope.workspaceId.toLowerCase() ||
      manifest.factoryId !== scope.factoryId.toLowerCase() ||
      manifest.experimentId !== scope.experimentId ||
      manifest.exportId !== exportId
    ) {
      throw new Error("The retained comparison manifest did not match the requested export.");
    }
  } else {
    const page = benchmarkComparisonExportPageSchema.parse(body);
    if (page.exportId !== exportId || page.ordinal !== part.ordinal || page.kind !== part.kind) {
      throw new Error("The retained comparison page did not match the requested export.");
    }
  }
  return data;
}
