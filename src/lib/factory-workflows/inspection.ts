import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "@/lib/supabase/database.types";

import {
  type WorkflowInspection,
  type WorkflowInspectionCursor,
  type WorkflowInspectionHeader,
  workflowInspectionCursorSchema,
  workflowInspectionHeaderSchema,
  workflowInspectionProjectionSchema,
} from "./inspection-contracts";

type InspectionClient = SupabaseClient<Database>;

async function readWorkflowInspection(
  supabase: InspectionClient,
  {
    sessionId,
    runId,
    before,
    pageSize,
    signal,
  }: {
    sessionId: string;
    runId?: string;
    before?: WorkflowInspectionCursor;
    pageSize: number;
    signal?: AbortSignal;
  },
) {
  const query = supabase.rpc("read_factory_workflow_inspection", {
    p_session_id: sessionId,
    p_run_id: runId,
    p_before: before,
    p_page_size: pageSize,
  });
  const { data, error } = await (signal ? query.abortSignal(signal) : query);
  if (error) throw error;
  return data;
}

export async function loadWorkflowInspectionHeader(
  supabase: InspectionClient,
  sessionId: string,
  runId?: string,
): Promise<WorkflowInspectionHeader | null> {
  try {
    const data = await readWorkflowInspection(supabase, { sessionId, runId, pageSize: 0 });
    return workflowInspectionHeaderSchema.safeParse(data).data ?? null;
  } catch {
    return null;
  }
}

export function parseWorkflowInspectionCursor(token: string): WorkflowInspectionCursor | null {
  try {
    return workflowInspectionCursorSchema.parse(
      JSON.parse(Buffer.from(token, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export async function loadWorkflowInspection(
  supabase: InspectionClient,
  {
    sessionId,
    runId,
    before,
    signal,
  }: {
    sessionId: string;
    runId?: string;
    before?: WorkflowInspectionCursor;
    signal?: AbortSignal;
  },
): Promise<WorkflowInspection | null> {
  const data = await readWorkflowInspection(supabase, {
    sessionId,
    runId,
    before,
    pageSize: 25,
    signal,
  });
  if (data === null) return null;

  const { nextCursor, ...projection } = workflowInspectionProjectionSchema.parse(data);
  return {
    ...projection,
    nextCursor: nextCursor ? Buffer.from(JSON.stringify(nextCursor)).toString("base64url") : null,
  };
}
