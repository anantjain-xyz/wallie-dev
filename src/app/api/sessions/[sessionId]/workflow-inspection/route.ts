import { z } from "zod";

import {
  loadWorkflowInspection,
  parseWorkflowInspectionCursor,
} from "@/lib/factory-workflows/inspection";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const preferredRegion = "home";

const uuid = z.string().uuid();
const querySchema = z.object({
  runId: uuid.optional(),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,640}$/)
    .optional(),
});
const headers = { "Cache-Control": "private, no-store" };

function fail(error: string, status: number) {
  return Response.json({ error }, { headers, status });
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const sessionId = uuid.safeParse((await params).sessionId);
  if (!sessionId.success) return fail("Workflow not found.", 404);

  const search = new URL(request.url).searchParams;
  const query = querySchema.safeParse({
    runId: search.get("runId") ?? undefined,
    cursor: search.get("cursor") ?? undefined,
  });
  if (!query.success) return fail("Invalid workflow inspection request.", 400);
  const { runId, cursor } = query.data;
  const before = cursor === undefined ? undefined : parseWorkflowInspectionCursor(cursor);
  if (
    cursor !== undefined &&
    (!before || before.sessionId !== sessionId.data || before.runId !== (runId ?? null))
  ) {
    return fail("Invalid workflow history cursor.", 400);
  }

  try {
    const supabase = await createSupabaseServerClient();
    if (!(await getSupabaseUserOrNull(supabase))) return fail("Unauthorized.", 401);

    const projection = await loadWorkflowInspection(supabase, {
      sessionId: sessionId.data,
      runId,
      before: before ?? undefined,
      signal: request.signal,
    });
    if (!projection) return fail("Workflow not found.", 404);
    return Response.json(projection, { headers });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "22023") {
      return fail("Invalid workflow history cursor.", 400);
    }
    return fail("Workflow history is unavailable.", 503);
  }
}
