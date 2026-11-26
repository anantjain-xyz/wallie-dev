import Link from "next/link";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import {
  AgentDirectoryDraftScope,
  AgentDirectoryFactorySelector,
} from "@/features/factory-agents/agent-directory-draft";
import { AgentFactoryRecovery } from "@/features/factory-agents/agent-factory-recovery";
import { agentListQuery } from "@/features/factory-agents/agent-navigation";
import { loadAgentPageScope, loadAgentsList } from "@/features/factory-agents/agent-pages-data";
import { AgentPromptForm } from "@/features/factory-agents/agent-prompt-form";
import { workspaceAgentDetailPath, workspaceAgentsPath } from "@/lib/routes";

export default async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    q?: string | string[];
  }>;
}) {
  const [{ workspaceSlug }, query] = await Promise.all([params, searchParams]);
  const { scope, factories, selection } = await loadAgentPageScope(workspaceSlug, query.factory);
  if (!scope)
    return (
      <AgentFactoryRecovery
        choose={selection === "choose"}
        factories={factories}
        workspaceSlug={workspaceSlug}
      />
    );

  const { factory, canEditPrompt, workspaceId } = scope;
  const { q, after } = agentListQuery(query);
  const { agents, nextAfterId, implementationAgentId, usesFactoryDefault } = await loadAgentsList(
    scope,
    { afterId: after, search: q },
  );
  const factoryQuery = { factory: factory.id };
  const directoryQuery = { ...factoryQuery, q };

  const directory = (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Agents"
        description="Agents are named sets of instructions. The published definition sets the execution harness, such as Codex or Claude Code."
        actions={
          <>
            <AgentDirectoryFactorySelector factories={factories} selectedValue={factory.id} />
            {canEditPrompt ? (
              <Link className="ui-button ui-button-primary" href="#new-agent">
                New agent
              </Link>
            ) : null}
          </>
        }
        actionsRightOnDesktop
      />
      <div className="space-y-8">
        <section aria-label="Factory agents" className="ui-sheet divide-y divide-border">
          <form
            action={workspaceAgentsPath(workspaceSlug)}
            className="flex flex-wrap items-end gap-2 px-4 py-4 sm:px-5"
            key={`${factory.id}:${q ?? ""}`}
            method="get"
            role="search"
          >
            <input name="factory" type="hidden" value={factory.id} />
            <label className="min-w-0 flex-1 basis-52 space-y-1.5">
              <span className="block type-label text-foreground">
                Search agents by name or slug
              </span>
              <input
                autoComplete="off"
                className="ui-input"
                defaultValue={q}
                maxLength={120}
                name="q"
                type="search"
              />
            </label>
            <button className="ui-button" type="submit">
              Search
            </button>
            {q && (
              <Link className="ui-button" href={workspaceAgentsPath(workspaceSlug, factoryQuery)}>
                Clear search
              </Link>
            )}
          </form>
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
                      href={workspaceAgentDetailPath(workspaceSlug, agent.id, {
                        ...directoryQuery,
                        after,
                      })}
                    >
                      {agent.name}
                    </Link>
                    <p className="type-annotation mt-1 break-words text-muted">{agent.slug}</p>
                  </div>
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {(agent.id === implementationAgentId ||
                      (usesFactoryDefault && agent.is_default)) && (
                      <span className="type-label text-muted">Used by published definition</span>
                    )}
                    {agent.is_default && (
                      <span className="type-label text-muted">Factory default</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary px-4 py-5 text-muted sm:px-5">
              {after
                ? "No more agents on this page."
                : q
                  ? "No matching agents."
                  : "No agents in this factory yet."}
            </p>
          )}
          {after || nextAfterId ? (
            <div className="flex flex-wrap gap-2 px-4 py-3 sm:px-5">
              {after && (
                <Link
                  className="ui-button"
                  href={workspaceAgentsPath(workspaceSlug, directoryQuery)}
                >
                  First page
                </Link>
              )}
              {nextAfterId && (
                <Link
                  className="ui-button"
                  href={workspaceAgentsPath(workspaceSlug, {
                    ...directoryQuery,
                    after: nextAfterId,
                  })}
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
              key={factory.id}
              workspaceId={workspaceId}
              workspaceSlug={workspaceSlug}
            />
          </PageSection>
        )}
      </div>
    </PageContainer>
  );
  return <AgentDirectoryDraftScope>{directory}</AgentDirectoryDraftScope>;
}
