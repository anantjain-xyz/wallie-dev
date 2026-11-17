import { z } from "zod";

import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const scopeSchema = z.object({ workspaceId: z.string().uuid(), factoryId: z.string().uuid() });
export const factoryAgentResponseHeaders = { "Cache-Control": "private, no-store" };

export async function resolveFactoryAgentRouteContext(params: Promise<unknown>) {
  const scope = scopeSchema.safeParse(await params);
  if (!scope.success) {
    return {
      ok: false as const,
      response: Response.json(
        { error: "Provide a valid workspace and factory ID." },
        { status: 400, headers: factoryAgentResponseHeaders },
      ),
    };
  }
  const access = await requireWorkspaceAccessById(scope.data.workspaceId);
  if (!access.ok) {
    return {
      ok: false as const,
      response: Response.json(
        { error: access.error },
        { status: access.status, headers: factoryAgentResponseHeaders },
      ),
    };
  }
  const { data: factory, error } = await access.context.supabase
    .from("factories")
    .select("id")
    .eq("workspace_id", scope.data.workspaceId)
    .eq("id", scope.data.factoryId)
    .maybeSingle();
  if (error) throw error;
  if (!factory) {
    return {
      ok: false as const,
      response: Response.json(
        { error: "Factory not found." },
        { status: 404, headers: factoryAgentResponseHeaders },
      ),
    };
  }
  return { ok: true as const, ...scope.data, access: access.context };
}
