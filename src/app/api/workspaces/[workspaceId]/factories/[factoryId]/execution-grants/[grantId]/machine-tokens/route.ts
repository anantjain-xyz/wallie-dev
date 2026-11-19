import { z } from "zod";

import { isFactoryExecutionAuthorityJsonRequest } from "@/lib/factory-execution-grants/contracts";
import { factoryMachineTokenCommandSchema } from "@/lib/factory-machine-tokens/contracts";
import { issueFactoryMachineTokenSecret } from "@/lib/factory-machine-tokens/secret";
import {
  factoryResponseHeaders as headers,
  resolveFactoryRouteContext,
} from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type RouteContext = {
  params: Promise<{ workspaceId: string; factoryId: string; grantId: string }>;
};

export async function POST(request: Request, { params }: RouteContext) {
  const { grantId: rawGrantId } = await params;
  const grantId = z.string().uuid().safeParse(rawGrantId);
  if (!grantId.success) {
    return Response.json(
      { error: "Provide a valid execution grant ID." },
      { status: 400, headers },
    );
  }

  const scope = await resolveFactoryRouteContext(params);
  if (!scope.ok) return scope.response;
  if (!isFactoryExecutionAuthorityJsonRequest(request)) {
    return Response.json({ error: "Send a JSON request body." }, { status: 415, headers });
  }
  const command = factoryMachineTokenCommandSchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!command.success) {
    return Response.json(
      { error: "Provide a valid machine token command." },
      { status: 400, headers },
    );
  }

  const admin = createSupabaseAdminClient();
  const actor = {
    p_workspace_id: scope.workspaceId,
    p_factory_id: scope.factoryId,
    p_actor_user_id: scope.access.user.id,
    p_grant_id: grantId.data,
  };
  const input = command.data;
  if (input.action === "revoke") {
    const { error } = await admin.rpc("revoke_factory_machine_token", {
      ...actor,
      p_token_id: input.tokenId,
    });
    if (error) {
      return Response.json(
        { error: "Could not revoke the machine token." },
        { status: factoryErrorStatus(error.code), headers },
      );
    }
    return Response.json({ revoked: true }, { headers });
  }

  const { credential, digest, tokenId } = issueFactoryMachineTokenSecret();
  const { data, error } = await admin.rpc("issue_factory_machine_token", {
    ...actor,
    p_grant_version: input.grantVersion,
    p_digest: digest,
    p_token_id: tokenId,
    p_name: input.name,
    p_scopes: input.scopes,
    p_expires_at: input.expiresAt,
  });
  if (error || !data) {
    const status = factoryErrorStatus(error?.code);
    const message =
      status === 422
        ? "Choose a name and approved scopes. Any expiry must be within the grant."
        : status === 403
          ? "An active execution grant must authorize the selected scopes."
          : "Could not create the machine token.";
    return Response.json({ error: message }, { status, headers });
  }
  return Response.json({ credential }, { status: 201, headers });
}
