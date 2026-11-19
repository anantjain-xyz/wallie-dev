import { after } from "next/server";

import {
  listFactoryDefinitionSmokeTests,
  readFactoryDefinitionSmokeEligibility,
  startFactoryDefinitionSmokeTest,
} from "@/lib/factory-definitions/candidate-smoke";
import {
  candidateSmokeHistoryQuerySchema,
  candidateSmokeStartSchema,
} from "@/lib/factory-definitions/candidate-smoke-contracts";
import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import {
  factoryDefinitionRouteParamsSchema,
  type FactoryDefinitionRouteContext,
} from "@/lib/factory-definitions/route-params";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const headers = { "Cache-Control": "private, no-store" };

export const maxDuration = 180;

function respond(body: unknown, status = 200) {
  return Response.json(body, { headers, status });
}

export async function GET(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  const query = new URL(request.url).searchParams;
  const selection = candidateSmokeHistoryQuerySchema.safeParse(Object.fromEntries(query));
  if (!workspace.success || !selection.success || query.size !== 3) {
    return respond(
      { error: "Specify a saved target kind, target ID, and definition digest." },
      400,
    );
  }

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);

    const scope = {
      workspaceId: access.context.workspace.id,
      ...(workspace.data.factoryId ? { factoryId: workspace.data.factoryId } : {}),
      ...selection.data,
    };
    const [history, read] = await Promise.all([
      listFactoryDefinitionSmokeTests({ client: access.context.supabase, ...scope }),
      readFactoryDefinitionSmokeEligibility({
        admin: createSupabaseAdminClient(),
        actorUserId: access.context.user.id,
        ...scope,
      }),
    ]);
    if (!history.ok) return respond({ error: history.error }, history.status);
    if (!read.ok) return respond({ error: read.error }, read.status);
    return respond({ tests: history.tests, eligibility: read.eligibility });
  } catch {
    return respond({ error: "Could not load candidate smoke tests." }, 500);
  }
}

export async function POST(request: Request, { params }: FactoryDefinitionRouteContext) {
  const workspace = factoryDefinitionRouteParamsSchema.safeParse(await params);
  if (!workspace.success) return respond({ error: "Invalid workspace id." }, 400);

  try {
    const access = await requireWorkspaceAccessById(workspace.data.workspaceId, {
      requireManager: true,
    });
    if (!access.ok) return respond({ error: access.error }, access.status);

    const body = parseFactoryDefinitionJson(await request.text().catch(() => ""));
    if (!body.ok) return respond({ error: body.message }, 400);
    const command = candidateSmokeStartSchema.safeParse(body.value);
    if (!command.success) {
      return respond(
        { error: "Specify a saved target, activation number, and definition digest." },
        400,
      );
    }

    const result = await startFactoryDefinitionSmokeTest({
      admin: createSupabaseAdminClient(),
      workspaceId: access.context.workspace.id,
      ...(workspace.data.factoryId ? { factoryId: workspace.data.factoryId } : {}),
      actorUserId: access.context.user.id,
      command: command.data,
    });
    if (!result.ok) {
      return respond({ error: result.error, diagnostics: result.diagnostics }, result.status);
    }
    if (result.run) after(result.run);
    return respond({ test: result.test }, result.run ? 202 : 201);
  } catch {
    return respond({ error: "Could not start the candidate smoke test." }, 500);
  }
}
