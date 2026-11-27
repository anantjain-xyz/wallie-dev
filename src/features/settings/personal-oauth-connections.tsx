import "server-only";

import Link from "next/link";

import {
  ConnectionSupportDetails,
  DisconnectPersonalClient,
} from "@/features/settings/personal-oauth-actions";
import {
  loadPersonalOAuthConnections,
  type PersonalOAuthGrant,
} from "@/features/settings/personal-oauth-data";
import { WorkspaceSettingsLoadError } from "@/features/settings/workspace-settings-load-error";
import { Section } from "@/features/settings/settings-ui";
import { loadAuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";
import { workspaceSettingsPath } from "@/lib/routes";

const formatter = new Intl.DateTimeFormat("en", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

function timeLabel(value: string) {
  return `${formatter.format(new Date(value))} UTC`;
}

function scopeLabels(scopes: PersonalOAuthGrant["scopes"]) {
  return scopes.map((scope) => factoryCommandLabels[scope]).join(", ");
}

function ConnectionMetadata({ grant }: { grant: PersonalOAuthGrant }) {
  return (
    <span className="block space-y-1 type-secondary text-muted [overflow-wrap:anywhere]">
      {grant.factories.length ? (
        grant.factories.map((factory) => (
          <span className="block" key={factory.id}>
            <span className="font-medium text-foreground">{factory.name}</span> ·{" "}
            {scopeLabels(factory.scopes)}
          </span>
        ))
      ) : (
        <span className="block">
          Factory details unavailable · Approved scopes: {scopeLabels(grant.scopes)}
        </span>
      )}
      <span className="block">
        Connected <time dateTime={grant.connectedAt}>{timeLabel(grant.connectedAt)}</time>
      </span>
    </span>
  );
}

export async function PersonalOAuthConnections({
  afterOAuthGrant,
  history = false,
  workspaceSlug,
}: {
  afterOAuthGrant?: string;
  history?: boolean;
  workspaceSlug: string;
}) {
  const { currentMember, supabase, workspace } =
    await loadAuthenticatedWorkspaceContext(workspaceSlug);
  if (!currentMember.is_active || currentMember.kind !== "human") return null;
  let data: Awaited<ReturnType<typeof loadPersonalOAuthConnections>>;
  try {
    data = await loadPersonalOAuthConnections({
      afterGrantId: afterOAuthGrant,
      history,
      memberId: currentMember.id,
      supabase,
      workspaceId: workspace.id,
    });
  } catch {
    return (
      <Section anchorId="connected-clients" heading="h3" title="Connected clients">
        <WorkspaceSettingsLoadError label="connected clients" />
      </Section>
    );
  }

  const pageHref = (showHistory: boolean, after?: string) =>
    `${workspaceSettingsPath(workspace.slug, { category: "workspace", oauthView: showHistory ? "history" : undefined, afterOAuthGrant: after })}#connected-clients`;
  return (
    <Section
      anchorId="connected-clients"
      heading="h3"
      tagline={`Clients you’ve authorized to act as you in ${workspace.name}, within the factory permissions listed below.`}
      title="Connected clients"
    >
      <nav aria-label="Connected client views" className="flex flex-wrap gap-2">
        <Link
          aria-current={!history ? "page" : undefined}
          className="ui-button aria-[current=page]:bg-control-hover"
          href={pageHref(false)}
        >
          Active connections
        </Link>
        <Link
          aria-current={history ? "page" : undefined}
          className="ui-button aria-[current=page]:bg-control-hover"
          href={pageHref(true)}
        >
          Connection history
        </Link>
      </nav>
      {data.grants.length ? (
        <ul className="ui-sheet mt-3 divide-y divide-border">
          {data.grants.map((grant) => (
            <li className="space-y-3 p-4 sm:p-5" key={grant.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 space-y-1">
                  <h4 className="font-semibold text-foreground [overflow-wrap:anywhere]">
                    {grant.clientName}
                  </h4>
                  <ConnectionMetadata grant={grant} />
                </div>
                {grant.status === "Active" ? (
                  <DisconnectPersonalClient
                    grantId={grant.id}
                    identity={`${grant.clientName}, connected ${timeLabel(grant.connectedAt)}, ${grant.factories.map((factory) => `${factory.name}: ${scopeLabels(factory.scopes)}`).join("; ") || scopeLabels(grant.scopes)}`}
                    metadata={<ConnectionMetadata grant={grant} />}
                    name={grant.clientName}
                    workspaceId={workspace.id}
                  />
                ) : (
                  <span className="type-label text-muted">{grant.status}</span>
                )}
              </div>
              <p className="type-secondary text-muted">
                {grant.status === "Expired" ? "Expired on" : "Expires"}{" "}
                <time dateTime={grant.expiresAt}>{timeLabel(grant.expiresAt)}</time>
              </p>
              <ConnectionSupportDetails grantId={grant.id} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 type-secondary text-muted">
          {afterOAuthGrant
            ? "No connections on this page."
            : history
              ? "No expired or disconnected clients."
              : "No active connections."}
        </p>
      )}
      {(afterOAuthGrant || data.next) && (
        <div className="mt-3 flex flex-wrap gap-2">
          {afterOAuthGrant && (
            <Link className="ui-button" href={pageHref(history)}>
              First page
            </Link>
          )}
          {data.next && (
            <Link className="ui-button" href={pageHref(history, data.next)}>
              Next page
            </Link>
          )}
        </div>
      )}
    </Section>
  );
}
