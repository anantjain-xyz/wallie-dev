import { z } from "zod";

import { resolveAppOrigin } from "@/lib/app-url";
import {
  authenticateFactoryOAuthBrowser,
  isSameOriginFactoryOAuthPost,
} from "@/lib/factory-oauth/browser-auth";
import { issueFactoryOAuthCredential } from "@/lib/factory-oauth/credentials";
import {
  factoryOAuthHeaders,
  factoryOAuthRedirect,
  factoryOAuthRedirectUriSchema,
  readFactoryOAuthForm,
} from "@/lib/factory-oauth/protocol";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const decisionSchema = z.object({
  authorizationId: z.string().uuid(),
  decision: z.enum(["allow", "deny"]),
  factoryIds: z
    .array(z.string().uuid().toLowerCase())
    .max(20)
    .refine((ids) => new Set(ids).size === ids.length),
});

function errorResponse(status: number, error = "invalid_request") {
  return Response.json({ error }, { status, headers: factoryOAuthHeaders });
}

export async function POST(request: Request) {
  if (!isSameOriginFactoryOAuthPost(request)) return errorResponse(403);

  const form = await readFactoryOAuthForm(request);
  if (
    !form ||
    form.getAll("authorizationId").length !== 1 ||
    form.getAll("decision").length !== 1 ||
    [...form.keys()].some((key) => !["authorizationId", "decision", "factoryIds"].includes(key))
  ) {
    return errorResponse(400);
  }
  const parsed = decisionSchema.safeParse({
    authorizationId: form.get("authorizationId"),
    decision: form.get("decision"),
    factoryIds: form.getAll("factoryIds"),
  });
  if (!parsed.success) return errorResponse(400);
  const { authorizationId, decision, factoryIds } = parsed.data;
  const allow = decision === "allow";
  if (allow && factoryIds.length === 0) return errorResponse(400);

  const actor = await authenticateFactoryOAuthBrowser();
  if (!actor?.sessionId) return errorResponse(401);
  const code = allow ? issueFactoryOAuthCredential("code") : undefined;
  const { data, error } = await createSupabaseAdminClient()
    .rpc("decide_factory_oauth_authorization", {
      p_authorization_id: authorizationId,
      p_actor_user_id: actor.id,
      p_actor_session_id: actor.sessionId,
      p_allow: allow,
      ...(code && { p_factory_ids: factoryIds, p_code_id: code.id, p_code_digest: code.digest }),
    })
    .single();
  if (error || !data) {
    if (error?.code === "42501") return errorResponse(403);
    if (error?.code === "P0002" || error?.code === "22023" || error?.code === "PT409") {
      return errorResponse(400);
    }
    return errorResponse(500, "server_error");
  }

  const registeredRedirect = factoryOAuthRedirectUriSchema.safeParse(data.redirect_uri);
  if (!registeredRedirect.success || data.approved !== allow)
    return errorResponse(500, "server_error");
  const location = factoryOAuthRedirect({
    issuer: resolveAppOrigin(),
    redirectUri: registeredRedirect.data,
    state: data.state ?? undefined,
    response: code
      ? { kind: "code", code: code.credential }
      : { kind: "error", error: "access_denied" },
  });
  return new Response(null, {
    status: 303,
    headers: { ...factoryOAuthHeaders, Location: location.href },
  });
}
