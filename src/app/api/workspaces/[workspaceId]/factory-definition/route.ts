import { z } from "zod";

import { mutateFactoryDefinition } from "@/lib/factory-definitions/mutations";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };
const headers = { "Cache-Control": "private, no-store" };
const workspaceIdSchema = z.string().uuid();
const positiveDecimal = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().safe().positive());
const historyQuerySchema = z
  .object({
    beforeActivationNumber: positiveDecimal.optional(),
    limit: positiveDecimal.pipe(z.number().max(100)).default("25"),
  })
  .strict();
const expectedActivationNumber = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER - 1);
const definitionSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("structured"), value: z.record(z.unknown()) }).strict(),
  z.object({ kind: z.literal("json"), text: z.string() }).strict(),
]);
const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("draft"),
      expectedActivationNumber,
      source: definitionSourceSchema,
    })
    .strict(),
  z
    .object({ action: z.literal("publish"), expectedActivationNumber, draftId: z.string().uuid() })
    .strict(),
  z
    .object({
      action: z.literal("rollback"),
      expectedActivationNumber,
      revisionId: z.string().uuid(),
    })
    .strict(),
]);

const activationColumns =
  "id, revision_id, activation_number, previous_activation_number, created_at";
type ActivationRow = Pick<
  Tables<"factory_definition_activations">,
  "id" | "revision_id" | "activation_number" | "previous_activation_number" | "created_at"
>;

function summarizeActivation(row: ActivationRow) {
  return {
    id: row.id,
    revisionId: row.revision_id,
    activationNumber: row.activation_number,
    previousActivationNumber: row.previous_activation_number,
    createdAt: row.created_at,
  };
}

function errorResponse(error: string, status: number) {
  return Response.json({ error }, { status, headers });
}

export async function GET(request: Request, { params }: RouteContext) {
  const workspaceId = workspaceIdSchema.safeParse((await params).workspaceId);
  const query = historyQuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!workspaceId.success || !query.success) {
    return errorResponse("Invalid factory activation history request.", 400);
  }

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data);
    if (!access.ok) return errorResponse(access.error, access.status);
    const { supabase, workspace } = access.context;
    const { data: factory, error: factoryError } = await supabase
      .from("factories")
      .select("id")
      .eq("workspace_id", workspace.id)
      .eq("is_default", true)
      .maybeSingle();
    if (factoryError) throw factoryError;
    if (!factory) return errorResponse("Default factory not found.", 404);

    const scopedActivations = () =>
      supabase
        .from("factory_definition_activations")
        .select(activationColumns)
        .eq("workspace_id", workspace.id)
        .eq("factory_id", factory.id)
        .order("activation_number", { ascending: false });
    const { data: current, error: currentError } = await scopedActivations().limit(1).maybeSingle();
    if (currentError) throw currentError;

    const { beforeActivationNumber, limit } = query.data;
    const currentActivation = current ? summarizeActivation(current) : null;
    // A later activation cannot appear in the page above the head read for this response.
    const throughActivationNumber = Math.min(
      current?.activation_number ?? 0,
      beforeActivationNumber === undefined ? Infinity : beforeActivationNumber - 1,
    );
    if (!throughActivationNumber) {
      return Response.json(
        {
          factoryId: factory.id,
          currentActivation,
          activations: [],
          nextBeforeActivationNumber: null,
        },
        { headers },
      );
    }

    const { data: history, error: historyError } = await scopedActivations()
      .lte("activation_number", throughActivationNumber)
      .limit(limit + 1);
    if (historyError) throw historyError;
    const activations = (history ?? []).slice(0, limit).map(summarizeActivation);
    const nextBeforeActivationNumber =
      (history?.length ?? 0) > limit ? activations[limit - 1].activationNumber : null;
    return Response.json(
      { factoryId: factory.id, currentActivation, activations, nextBeforeActivationNumber },
      { headers },
    );
  } catch {
    return errorResponse("Could not load factory activation history.", 500);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  const workspaceId = workspaceIdSchema.safeParse((await params).workspaceId);
  if (!workspaceId.success) return errorResponse("Invalid workspace id.", 400);

  try {
    const access = await requireWorkspaceAccessById(workspaceId.data, { requireManager: true });
    if (!access.ok) return errorResponse(access.error, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return errorResponse(body.message, 400);
    const command = commandSchema.safeParse(body.value);
    if (!command.success) return errorResponse("Invalid factory definition command.", 400);

    const result = await mutateFactoryDefinition({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      actorUserId: access.context.user.id,
      command: command.data,
    });
    if (!result.ok) {
      return Response.json(
        { error: result.error, diagnostics: result.diagnostics },
        { status: result.status, headers },
      );
    }
    return Response.json(result.result, { status: 201, headers });
  } catch {
    return errorResponse("Could not update the factory definition.", 500);
  }
}
