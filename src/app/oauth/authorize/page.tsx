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
  title: { absolute: "Review app access · Wallie" },
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
      <PageHeader className="mb-4 sm:mb-5" title="Review app access" />
      <div className="ui-sheet min-w-0 space-y-5 p-4 sm:p-5">
        <div className="space-y-2 [overflow-wrap:anywhere]">
          <p className="type-body text-foreground">
            <strong>{client_name}</strong> is asking for access in <strong>{workspace_name}</strong>
            .
          </p>
          <form
            action="/auth/signout"
            method="post"
            className="flex flex-wrap items-center gap-x-3 gap-y-1"
          >
            <input type="hidden" name="next" value={resumePath} />
            <input type="hidden" name="switchAccount" value="1" />
            <p className="type-secondary min-w-0 text-muted">
              Signed in as{" "}
              <strong className="font-medium text-foreground">
                {actor.email || "the current Wallie account"}
              </strong>
            </p>
            <button
              className="ui-touch-target inline-flex min-h-11 items-center rounded-[6px] text-sm font-medium text-foreground underline decoration-border-strong underline-offset-4 hover:decoration-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              type="submit"
            >
              Use a different account
            </button>
          </form>
        </div>
        <ConsentForm
          authorizationId={authorization_id}
          technicalDetails={
            target ? { issuer: resolveAppOrigin(), resource: target.resource } : undefined
          }
        >
          <fieldset className="min-w-0 space-y-3 border-t border-border pt-3">
            <legend className="type-label pr-2 text-foreground">
              {target ? "Factory permissions" : "Choose factories"}
            </legend>
            <p className="type-secondary text-muted">
              {target
                ? "Allowing access grants all actions listed for this factory."
                : "The app gets all listed actions for each factory you select."}
            </p>
            {factories.map((factory) => {
              const scopeId = `scopes-${factory.factory_id}`;
              const slug = slugs.get(factory.factory_id);
              return (
                <div className="min-w-0 border-b border-border pb-3" key={factory.factory_id}>
                  {target ? (
                    <>
                      <input name="factoryIds" type="hidden" value={factory.factory_id} />
                      <p className="type-body font-semibold text-foreground [overflow-wrap:anywhere]">
                        {factory.name}
                      </p>
                    </>
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
                  <ul
                    className={`type-secondary list-disc space-y-1 pl-5 ${target ? "mt-1" : "ml-6"}`}
                    id={scopeId}
                  >
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
              );
            })}
          </fieldset>
          <p className="type-secondary text-muted [overflow-wrap:anywhere]">
            Either choice returns you to <strong>{client_name}</strong> (
            {new URL(request.redirectUri).origin}). If you deny, no access is granted.
          </p>
        </ConsentForm>
      </div>
    </PageContainer>
  );
}
