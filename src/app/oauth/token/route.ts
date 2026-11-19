import { z } from "zod";

import {
  factoryOAuthPKCEChallenge,
  issueFactoryOAuthCredential,
  parseFactoryOAuthCredential,
} from "@/lib/factory-oauth/credentials";
import {
  factoryOAuthHeaders,
  parseFactoryOAuthToken,
  readFactoryOAuthForm,
} from "@/lib/factory-oauth/protocol";
import { factoryCommandScopesSchema } from "@/lib/factory-machine-tokens/contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

const tokenResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("issued"),
    expires_in: z.number().int().positive(),
    scopes: factoryCommandScopesSchema.refine((scopes) => scopes.length > 0),
  }),
  z.object({ status: z.enum(["invalid_grant", "invalid_scope"]) }),
]);

type TokenError =
  | "invalid_request"
  | "invalid_grant"
  | "invalid_scope"
  | "unsupported_grant_type"
  | "server_error";

function tokenError(error: TokenError) {
  return Response.json(
    { error },
    { status: error === "server_error" ? 500 : 400, headers: factoryOAuthHeaders },
  );
}

export async function POST(request: Request) {
  if (request.headers.has("authorization")) return tokenError("invalid_request");
  const form = await readFactoryOAuthForm(request);
  if (!form) return tokenError("invalid_request");

  const parsed = parseFactoryOAuthToken(form);
  if (!parsed.ok) return tokenError(parsed.error);

  const input = parsed.request;
  const presented =
    input.kind === "authorization_code"
      ? parseFactoryOAuthCredential("code", input.code)
      : parseFactoryOAuthCredential("refresh", input.refreshToken);
  if (!presented) return tokenError("invalid_grant");

  const access = issueFactoryOAuthCredential("access");
  const refresh = issueFactoryOAuthCredential("refresh");
  try {
    const admin = createSupabaseAdminClient();
    const query =
      input.kind === "authorization_code"
        ? admin.rpc("exchange_factory_oauth_code", {
            p_client_id: input.clientId,
            p_redirect_uri: input.redirectUri,
            p_code_id: presented.id,
            p_code_digest: presented.digest,
            p_pkce_challenge: factoryOAuthPKCEChallenge(input.verifier),
            p_access_token_id: access.id,
            p_access_token_digest: access.digest,
            p_refresh_token_id: refresh.id,
            p_refresh_token_digest: refresh.digest,
          })
        : admin.rpc("rotate_factory_oauth_refresh_token", {
            p_client_id: input.clientId,
            p_refresh_token_id: presented.id,
            p_refresh_token_digest: presented.digest,
            p_next_access_token_id: access.id,
            p_next_access_token_digest: access.digest,
            p_next_refresh_token_id: refresh.id,
            p_next_refresh_token_digest: refresh.digest,
            p_requested_scopes: input.scopes,
          });
    const { data, error } = await query.single();
    if (error) return tokenError("server_error");
    const result = tokenResultSchema.safeParse(data);
    if (!result.success) return tokenError("server_error");
    if (result.data.status !== "issued") return tokenError(result.data.status);

    return Response.json(
      {
        access_token: access.credential,
        refresh_token: refresh.credential,
        token_type: "Bearer",
        expires_in: result.data.expires_in,
        scope: result.data.scopes.join(" "),
      },
      { headers: factoryOAuthHeaders },
    );
  } catch {
    return tokenError("server_error");
  }
}
