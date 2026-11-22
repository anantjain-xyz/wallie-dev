import Link from "next/link";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { loadAgentPageScope, loadAgentsList } from "@/features/factory-agents/agent-pages-data";
import { AgentPromptForm } from "@/features/factory-agents/agent-prompt-form";
import { workspaceAgentDetailPath, workspaceAgentsPath } from "@/lib/routes";

export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{ factory?: string | string[]; after?: string | string[] }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const scope = await loadAgentPageScope(workspaceSlug, query.factory);
  if (!scope) return <FactoryUnavailable title="Agents" workspaceSlug={workspaceSlug} />;

  const { factory, canEditPrompt, workspaceId } = scope;
  const after = z.string().uuid().safeParse(query.after);
  const { agents, nextAfterId, implementationAgentId } = await loadAgentsList(
    scope,
    after.success ? after.data : undefined,
  );
  const factoryQuery = { factory: factory.id };

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Agents"
        description={factory.status === "archived" ? `${factory.name} · Archived` : factory.name}
        actions={
          canEditPrompt ? (
            <Link className="ui-button ui-button-primary" href="#new-agent">
              New agent
            </Link>
          ) : undefined
        }
        actionsRightOnDesktop
      />
      <div className="space-y-8">
        <section aria-label="Factory agents" className="ui-sheet divide-y divide-border">
          {agents.length ? (
            <ul className="divide-y divide-border">
              {agents.map((agent) => (
                <li
                  className="flex min-w-0 flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-5"
                  key={agent.id}
                >
                  <div className="min-w-0">
                    <Link
                      className="break-words font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                      href={workspaceAgentDetailPath(workspaceSlug, agent.id, factoryQuery)}
                    >
                      {agent.name}
                    </Link>
                    <p className="type-annotation mt-1 break-words text-muted">{agent.slug}</p>
                  </div>
                  {agent.id === implementationAgentId ? (
                    <span className="type-label text-muted">Implementation agent</span>
                  ) : agent.is_default ? (
                    <span className="type-label text-muted">Factory default</span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary px-4 py-5 text-muted sm:px-5">No agents on this page.</p>
          )}
          {after.success || nextAfterId ? (
            <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
              {after.success && (
                <Link className="ui-button" href={workspaceAgentsPath(workspaceSlug, factoryQuery)}>
                  First page
                </Link>
              )}
              {nextAfterId && (
                <Link
                  className="ui-button"
                  href={workspaceAgentsPath(workspaceSlug, { ...factoryQuery, after: nextAfterId })}
                >
                  More agents
                </Link>
              )}
            </div>
          ) : null}
        </section>
        {canEditPrompt && (
          <PageSection anchorId="new-agent" title="Create an agent">
            <AgentPromptForm
              factoryId={factory.id}
              form={{ kind: "create" }}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
            />
          </PageSection>
        )}
      </div>
    </PageContainer>
  );
}
