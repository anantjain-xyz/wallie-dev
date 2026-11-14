import "server-only";

import { z } from "zod";

import {
  RUN_CATALOG_MAX_PAGE_SIZE,
  RUN_CATALOG_PAGE_SIZE,
  runCatalogFiltersSchema,
  type RunCatalogFilters,
  type RunCatalogQuery,
} from "@/features/wallie/run-catalog-contracts";
import {
  loadRunCatalogRecovery,
  type RunCatalogRecovery,
} from "@/features/wallie/run-catalog-recovery";
import { runCursorSchema, splitRunPage } from "@/features/wallie/run-pagination";
import type { WallieRunCursor } from "@/features/wallie/types";
import { parseRunFailure } from "@/lib/pipeline/run-failure";
import { workspaceSessionDetailPath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";
import type { createSupabaseServerClient } from "@/lib/supabase/server";

type CatalogRpc = Database["public"]["Functions"]["list_workspace_run_catalog"];
type GeneratedCatalogRow = CatalogRpc["Returns"][number];
// PostgREST type generation does not infer nullability for RETURNS TABLE fields.
type NullableCatalogField =
  | "job_id"
  | "attempt_count"
  | "stage_id"
  | "stage_name"
  | "started_at"
  | "finished_at"
  | "last_activity_at"
  | "failure_receipt"
  | "input_tokens"
  | "output_tokens"
  | "total_cost_usd"
  | "usage_finalized_at";
export type CatalogRow = Omit<GeneratedCatalogRow, NullableCatalogField> & {
  [Field in NullableCatalogField]: GeneratedCatalogRow[Field] | null;
};
type CatalogContext = {
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>;
  workspaceId: string;
  workspaceSlug: string;
};

const scopedRunCursorSchema = runCursorSchema.extend({
  version: z.literal(1),
  workspaceId: z.string().uuid(),
  filters: runCatalogFiltersSchema,
});

export class RunCatalogCursorError extends Error {
  constructor() {
    super("Invalid run catalog cursor.");
    this.name = "RunCatalogCursorError";
  }
}

export class RunCatalogWorkspaceUnavailableError extends Error {
  constructor() {
    super("Workspace not found.");
    this.name = "RunCatalogWorkspaceUnavailableError";
  }
}

export async function loadWorkspaceRunCatalogPage(
  input: CatalogContext & { query: RunCatalogQuery },
) {
  const { cursor: encoded, limit = RUN_CATALOG_PAGE_SIZE, ...filters } = input.query;
  const cursor = encoded ? readCatalogCursor(encoded, input.workspaceId, filters) : null;
  const boundedLimit = Math.min(RUN_CATALOG_MAX_PAGE_SIZE, Math.max(1, limit));
  const result = await readCatalog(input, {
    p_limit: boundedLimit + 1,
    ...(filters.sessionId ? { p_session_id: filters.sessionId } : {}),
    ...(filters.status ? { p_status: filters.status } : {}),
    ...(filters.provider ? { p_provider: filters.provider } : {}),
    ...(filters.stageId ? { p_stage_id: filters.stageId } : {}),
    ...(cursor ? { p_before_created_at: cursor.createdAt, p_before_id: cursor.id } : {}),
  });
  const { rows, nextCursor } = splitRunPage(result, boundedLimit, (row) => ({
    createdAt: row.created_at,
    id: row.run_id,
  }));
  return {
    runs: await withRecovery(input, rows),
    nextCursor: nextCursor ? writeCatalogCursor(nextCursor, input.workspaceId, filters) : null,
  };
}

export async function loadWorkspaceRunCatalogItem(input: CatalogContext & { runId: string }) {
  const rows = await readCatalog(input, { p_run_id: input.runId, p_limit: 1 });
  const [run] = await withRecovery(input, rows);
  return run ?? null;
}

async function readCatalog(
  input: CatalogContext,
  args: Omit<CatalogRpc["Args"], "p_workspace_id">,
) {
  const { data, error } = await input.supabase.rpc("list_workspace_run_catalog", {
    p_workspace_id: input.workspaceId,
    ...args,
  });
  if (error?.code === "P0002") throw new RunCatalogWorkspaceUnavailableError();
  if (error) throw error;
  return data ?? [];
}

async function withRecovery(input: CatalogContext, rows: CatalogRow[]) {
  if (rows.length === 0) return [];
  const recovery = await loadRunCatalogRecovery({
    supabase: input.supabase,
    workspaceId: input.workspaceId,
    rows,
  });
  return rows.map((row) =>
    toCatalogItem(row, input.workspaceSlug, recovery.get(row.run_id) ?? null),
  );
}

function toCatalogItem(
  row: CatalogRow,
  workspaceSlug: string,
  recovery: RunCatalogRecovery | null,
) {
  const failure = row.failure_receipt ? parseRunFailure(row.failure_receipt) : null;
  return {
    id: row.run_id,
    sessionId: row.session_id,
    sessionNumber: row.session_number,
    sessionTitle: row.session_title,
    sessionRunHref: `${workspaceSessionDetailPath(workspaceSlug, row.session_number)}#wallie-run-${row.run_id}`,
    attemptCount: row.attempt_count ?? null,
    stageId: row.stage_id ?? null,
    stageName: row.stage_name ?? null,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    status: row.status,
    interrupted: row.status === "error" && failure?.code === "timeout",
    failure,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    finishedAt: row.finished_at ?? null,
    lastActivityAt: row.last_activity_at ?? null,
    usage: {
      inputTokens: row.input_tokens ?? null,
      outputTokens: row.output_tokens ?? null,
      totalCostUsd: row.total_cost_usd ?? null,
      tokenProvenance: usageProvenance(row.token_provenance),
      costProvenance: usageProvenance(row.cost_provenance),
      finalized: Boolean(row.usage_finalized_at),
    },
    transcript: {
      hasEvents: row.has_events,
      hasLegacyMessages: row.has_legacy_messages,
      captureEnded: row.capture_ended,
      captureInterrupted: row.capture_interrupted,
    },
    recovery,
  };
}

function usageProvenance(value: string | null | undefined) {
  return value === "measured" || value === "estimated" ? value : "unavailable";
}

export type WorkspaceRunCatalogItem = ReturnType<typeof toCatalogItem>;
export type WorkspaceRunCatalogPage = Awaited<ReturnType<typeof loadWorkspaceRunCatalogPage>>;

function readCatalogCursor(
  encoded: string,
  workspaceId: string,
  filters: RunCatalogFilters,
): WallieRunCursor {
  try {
    const parsed = scopedRunCursorSchema.parse(
      JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
    );
    if (
      parsed.workspaceId === workspaceId &&
      parsed.filters.sessionId === filters.sessionId &&
      parsed.filters.status === filters.status &&
      parsed.filters.provider === filters.provider &&
      parsed.filters.stageId === filters.stageId
    ) {
      return { createdAt: parsed.createdAt, id: parsed.id };
    }
  } catch {
    // Treat invalid cursors the same as ones belonging to a different scope.
  }
  throw new RunCatalogCursorError();
}

function writeCatalogCursor(
  cursor: WallieRunCursor,
  workspaceId: string,
  filters: RunCatalogFilters,
) {
  return Buffer.from(JSON.stringify({ ...cursor, version: 1, workspaceId, filters })).toString(
    "base64url",
  );
}
