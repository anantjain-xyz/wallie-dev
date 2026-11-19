import "server-only";

import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { resolveAppOrigin } from "@/lib/app-url";
import {
  factoryCommandLabels,
  factoryCommandScopesSchema,
} from "@/lib/factory-machine-tokens/contracts";
import { parseFactoryMcpResource } from "@/lib/factory-mcp/resource";
import { authenticateFactoryOAuthBrowser } from "@/lib/factory-oauth/browser-auth";
import { factoryOAuthRedirect, parseFactoryOAuthAuthorization } from "@/lib/factory-oauth/protocol";
import { loginPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const metadata: Metadata = {
  title: { absolute: "Authorize client · Wallie" },
  referrer: "same-origin",
  robots: { index: false, follow: false },
};

const consentSchema = z.object({
  authorization_id: z.string().uuid(),
  client_name: z.string().min(1),
  workspace_id: z.string().uuid(),
  workspace_name: z.string().min(1),
  factories: z
    .array(
      z.object({
        factory_id: z.string().uuid(),
        name: z.string().min(1),
        scopes: factoryCommandScopesSchema.refine((scopes) => scopes.length > 0),
      }),
    )
    .min(1),
});

function Unavailable() {
  return (
    <PageContainer className="max-w-xl">
      <PageHeader title="Authorize client" />
      <p className="ui-sheet type-secondary text-muted p-4 sm:p-5">
        This authorization request is unavailable. Return to your client and start again.
      </p>
    </PageContainer>
  );
}

export default async function FactoryOAuthAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    if (typeof value === "string") params.append(key, value);
    else for (const entry of value ?? []) params.append(key, entry);
  }
  const parsed = parseFactoryOAuthAuthorization(params);
  if (!parsed.ok) return <Unavailable />;

  const request = parsed.request;
  const target = request.resource === undefined ? null : parseFactoryMcpResource(request.resource);
  const resource = request.resource === undefined ? undefined : (target?.resource ?? "");
  const actor = await authenticateFactoryOAuthBrowser();
  if (!actor) {
    const resume = new URLSearchParams({
      response_type: "code",
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      scope: request.scopes.join(" "),
      code_challenge: request.challenge,
      code_challenge_method: "S256",
    });
    if (request.state !== undefined) resume.set("state", request.state);
    if (resource !== undefined) resume.set("resource", resource);
    redirect(loginPath(`/oauth/authorize?${resume}`));
  }
  if (!actor.sessionId) return <Unavailable />;

  const { data, error } = await createSupabaseAdminClient()
    .rpc("begin_factory_oauth_authorization", {
      p_actor_user_id: actor.id,
      p_actor_session_id: actor.sessionId,
      p_client_id: request.clientId,
      p_redirect_uri: request.redirectUri,
      p_code_challenge: request.challenge,
      p_requested_scopes: request.scopes,
      p_state: request.state,
      p_resource: resource,
    })
    .single();
  if (resource !== undefined && error?.code === "PT400") {
    // A resource error follows the database's exact registered redirect check.
    redirect(
      factoryOAuthRedirect({
        issuer: resolveAppOrigin(),
        redirectUri: request.redirectUri,
        state: request.state,
        response: { kind: "error", error: "invalid_target" },
      }).href,
    );
  }
  if (error) return <Unavailable />;
  const consent = consentSchema.safeParse(data);
  if (!consent.success) return <Unavailable />;

  const { authorization_id, client_name, workspace_id, workspace_name, factories } = consent.data;
  if (
    resource !== undefined &&
    (!target ||
      target.workspaceId !== workspace_id ||
      factories.length !== 1 ||
      factories[0].factory_id !== target.factoryId)
  )
    return <Unavailable />;
  return (
    <PageContainer className="max-w-xl">
      <PageHeader title="Authorize client" />
      <form
        action="/oauth/authorize/decision"
        className="ui-sheet min-w-0 space-y-5 p-4 sm:p-5"
        method="post"
      >
        <input name="authorizationId" type="hidden" value={authorization_id} />
        <p className="type-body text-foreground [overflow-wrap:anywhere]">
          <strong>{client_name}</strong> is requesting access to <strong>{workspace_name}</strong>.
        </p>
        <p className="type-secondary text-muted [overflow-wrap:anywhere]">
          Returns to {new URL(request.redirectUri).origin}
        </p>
        <fieldset className="min-w-0 space-y-2">
          <legend className="type-label text-foreground">{target ? "Factory" : "Factories"}</legend>
          {!target && (
            <p className="type-secondary text-muted">
              Choose the factories this client can access.
            </p>
          )}
          {factories.map((factory) => (
            <div className="min-w-0 space-y-1" key={factory.factory_id}>
              {target ? (
                <>
                  <input name="factoryIds" type="hidden" value={factory.factory_id} />
                  <p className="text-sm text-foreground [overflow-wrap:anywhere]">{factory.name}</p>
                </>
              ) : (
                <label className="flex items-start gap-2 text-sm text-foreground [overflow-wrap:anywhere]">
                  <input
                    aria-describedby={`scopes-${factory.factory_id}`}
                    className="mt-0.5"
                    defaultChecked={factories.length === 1}
                    name="factoryIds"
                    type="checkbox"
                    value={factory.factory_id}
                  />
                  {factory.name}
                </label>
              )}
              <p
                className={target ? "type-secondary text-muted" : "type-secondary pl-5 text-muted"}
                id={`scopes-${factory.factory_id}`}
              >
                {factory.scopes.map((scope) => factoryCommandLabels[scope]).join(", ")}
              </p>
            </div>
          ))}
        </fieldset>
        {target && (
          <dl className="min-w-0 space-y-2 [overflow-wrap:anywhere]">
            <div>
              <dt className="type-label text-foreground">Issuer</dt>
              <dd className="type-secondary text-muted">{resolveAppOrigin()}</dd>
            </div>
            <div>
              <dt className="type-label text-foreground">Resource</dt>
              <dd className="type-secondary text-muted">{target.resource}</dd>
            </div>
          </dl>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button className="ui-button" name="decision" type="submit" value="deny">
            Deny
          </button>
          <button
            className="ui-button ui-button-primary"
            name="decision"
            type="submit"
            value="allow"
          >
            Allow access
          </button>
        </div>
      </form>
    </PageContainer>
  );
}
