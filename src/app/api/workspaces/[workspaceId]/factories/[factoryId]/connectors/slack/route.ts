import { connectorSetupErrorResponse } from "@/lib/connectors/setup";
import {
  slackConnectorSetupCommandSchema,
  slackConnectorSetupResultSchema,
  slackConnectorSetupSchema,
} from "@/lib/connectors/slack/contracts";
import {
  readSlackConnectorSetup,
  revokeOwnSlackLink,
  startSlackConnectorAuthorization,
} from "@/lib/connectors/slack/setup";
import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const preferredRegion = "home";

type RouteContext = { params: Promise<{ workspaceId: string; factoryId: string }> };

async function resolveSlackSetupContext(params: RouteContext["params"]) {
  const context = await resolveFactoryRouteContext(params, { includeSessionId: true });
  if (!context.ok) return context;
  const { role } = context.access.currentMember;
  return {
    ok: true as const,
    admin: createSupabaseAdminClient(),
    canConfigure: role === "owner" || role === "admin",
    sessionId: context.access.user.sessionId,
    scope: {
      p_workspace_id: context.workspaceId,
      p_factory_id: context.factoryId,
      p_actor_user_id: context.access.user.id,
    },
  };
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const context = await resolveSlackSetupContext(params);
    if (!context.ok) return context.response;
    const setup = await readSlackConnectorSetup(context.admin, context.scope, context.canConfigure);
    return Response.json(slackConnectorSetupSchema.parse(setup), { headers });
  } catch (error) {
    return connectorSetupErrorResponse(error);
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const context = await resolveSlackSetupContext(params);
    if (!context.ok) return context.response;
    if (!isFactoryExecutionAuthorityJsonRequest(request)) {
      return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
    }
    const raw = await readBoundedJsonBody(request, 2048);
    if (!raw.ok) {
      return Response.json(
        { error: "Invalid Slack setup command." },
        { status: raw.code === "request_too_large" ? 413 : 400, headers },
      );
    }
    const parsed = slackConnectorSetupCommandSchema.safeParse(raw.body);
    if (!parsed.success) {
      return Response.json({ error: "Invalid Slack setup command." }, { status: 400, headers });
    }
    const command = parsed.data;
    if (command.action === "install" && !context.canConfigure) {
      return Response.json(
        { error: "Workspace admin access is required to connect Slack." },
        { status: 403, headers },
      );
    }
    if (!context.sessionId) {
      return Response.json(
        { error: "Sign in again before changing Slack settings." },
        { status: 401, headers },
      );
    }
    const result =
      command.action === "revoke"
        ? await revokeOwnSlackLink(context.admin, context.scope, command)
        : await startSlackConnectorAuthorization(
            context.admin,
            context.scope,
            context.sessionId,
            command,
          );
    return Response.json(slackConnectorSetupResultSchema.parse(result), { headers });
  } catch (error) {
    return connectorSetupErrorResponse(error);
  }
}
