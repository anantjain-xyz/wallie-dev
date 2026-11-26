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
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { ConsentForm } from "./consent-form";
import { consentResumePath } from "./consent-navigation";
import { ConsentRecovery } from "./consent-recovery";

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
  if (!parsed.ok) return <ConsentRecovery />;

  const request = parsed.request;
  const target = request.resource === undefined ? null : parseFactoryMcpResource(request.resource);
  const resource = request.resource === undefined ? undefined : (target?.resource ?? "");
  const resumePath = consentResumePath(request);
  const actor = await authenticateFactoryOAuthBrowser();
  if (!actor) redirect(loginPath(resumePath));
  if (!actor.sessionId) return <ConsentRecovery resumePath={resumePath} />;

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
  if (error) return <ConsentRecovery resumePath={resumePath} />;
  const consent = consentSchema.safeParse(data);
  if (!consent.success) return <ConsentRecovery resumePath={resumePath} />;

  const { authorization_id, client_name, workspace_id, workspace_name, factories } = consent.data;
  if (
    resource !== undefined &&
    (!target ||
      target.workspaceId !== workspace_id ||
      factories.length !== 1 ||
      factories[0].factory_id !== target.factoryId)
  )
    return <ConsentRecovery resumePath={resumePath} />;

  const names = new Map<string, number>();
  for (const { name } of factories) names.set(name, (names.get(name) ?? 0) + 1);
  const duplicates = factories.filter(({ name }) => (names.get(name) ?? 0) > 1);
  const slugs = new Map<string, string>();
  if (duplicates.length > 0) {
    const supabase = await createSupabaseServerClient();
    const labels = await supabase
      .from("factories")
      .select("id,slug")
      .eq("workspace_id", workspace_id)
      .in(
        "id",
        duplicates.map(({ factory_id }) => factory_id),
      );
    if (labels.error || labels.data.length !== duplicates.length) {
      return <ConsentRecovery resumePath={resumePath} />;
    }
    for (const { id, slug } of labels.data) slugs.set(id, slug);
  }

  return (
    <PageContainer className="max-w-xl">
      <PageHeader title="Authorize client" />
      <div className="ui-sheet min-w-0 space-y-5 p-4 sm:p-5">
        <p className="type-body text-foreground [overflow-wrap:anywhere]">
          {target ? (
            <>
              Review <strong>{client_name}</strong>’s access to <strong>{factories[0].name}</strong>{" "}
              in <strong>{workspace_name}</strong>.
            </>
          ) : (
            <>
              Choose which factories <strong>{client_name}</strong> can access in{" "}
              <strong>{workspace_name}</strong>.
            </>
          )}
        </p>
        <form
          action="/auth/signout"
          method="post"
          className="flex flex-wrap items-center gap-x-3 gap-y-1"
        >
          <input type="hidden" name="next" value={resumePath} />
          <p className="type-secondary text-muted [overflow-wrap:anywhere]">
            Signed in as{" "}
            <strong className="font-medium text-foreground">
              {actor.email || "the current Wallie account"}
            </strong>
          </p>
          <button className="ui-button min-h-11" type="submit">
            Use a different account
          </button>
        </form>
        <ConsentForm
          authorizationId={authorization_id}
          technicalDetails={
            target ? { issuer: resolveAppOrigin(), resource: target.resource } : undefined
          }
        >
          <fieldset className="min-w-0 space-y-3 border-t border-border pt-3">
            <legend className="type-label pr-2 text-foreground">
              {target ? "Factory permissions" : "Factories"}
            </legend>
            <p className="type-secondary text-muted">
              {target
                ? "Allowing access grants all the listed actions together."
                : "For each factory you select, the app gets all the listed actions together."}
            </p>
            {factories.map((factory) => {
              const scopeId = `scopes-${factory.factory_id}`;
              const slug = slugs.get(factory.factory_id);
              return (
                <div className="min-w-0 border-b border-border pb-3" key={factory.factory_id}>
                  {target ? (
                    <input name="factoryIds" type="hidden" value={factory.factory_id} />
                  ) : (
                    <label className="flex min-h-11 items-center gap-2 text-sm font-medium text-foreground [overflow-wrap:anywhere]">
                      <input
                        aria-describedby={scopeId}
                        className="size-4 shrink-0 accent-accent"
                        defaultChecked={factories.length === 1}
                        name="factoryIds"
                        type="checkbox"
                        value={factory.factory_id}
                      />
                      <span>
                        {factory.name}
                        {slug && <span className="ml-2 font-normal text-muted">({slug})</span>}
                      </span>
                    </label>
                  )}
                  <div className={target ? "" : "ml-6"} id={scopeId}>
                    <p className="type-label text-muted">What this app can do</p>
                    <ul className="type-secondary mt-1 list-disc space-y-1 pl-5">
                      {factory.scopes.map((scope) => (
                        <li
                          className={
                            scope === "sessions:read" ? "text-muted" : "font-medium text-foreground"
                          }
                          key={scope}
                        >
                          {factoryCommandLabels[scope]}
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              );
            })}
          </fieldset>
          <p className="type-secondary text-muted [overflow-wrap:anywhere]">
            After you choose, you’ll return to <strong>{client_name}</strong> (
            {new URL(request.redirectUri).origin}). If you deny, no access is granted.
          </p>
        </ConsentForm>
      </div>
    </PageContainer>
  );
}
