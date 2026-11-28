import Link from "next/link";

import { scopeFactoryIndex } from "@/components/app-shell/workspace-factory-page.server";
import { BackLink } from "@/components/ui/back-link";
import { PAGE_HEADER_TITLE_CLASS, PageContainer, PageHeader } from "@/components/ui/page-shell";
import { FactoryAuthoringFocus } from "@/features/factories/factory-authoring-focus";
import {
  AgentDirectoryDraftScope,
  AgentDirectoryFactorySelector,
} from "@/features/factory-agents/agent-directory-draft";
import { AgentFactoryRecovery } from "@/features/factory-agents/agent-factory-recovery";
import { agentListQuery } from "@/features/factory-agents/agent-navigation";
import { loadAgentPageScope, loadAgentsList } from "@/features/factory-agents/agent-pages-data";
import { AgentPromptForm } from "@/features/factory-agents/agent-prompt-form";
import { workspaceAgentDetailPath, workspaceAgentsPath } from "@/lib/routes";

export default scopeFactoryIndex(AgentsPage, {
  picker: "guarded",
  resetParams: ["q", "new"],
  route: "agents",
  title: "Agents",
});

async function AgentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    after?: string | string[];
    q?: string | string[];
    new?: string | string[];
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
  const factoryQuery = { factory: factory.id };
  const directoryQuery = { ...factoryQuery, q };
  const selector = (
    <AgentDirectoryFactorySelector factories={factories} selectedValue={factory.id} />
  );

  if (canEditPrompt && query.new === "1") {
    return (
      <AgentDirectoryDraftScope>
        <PageContainer className="pt-5 sm:pt-10">
          <PageHeader
            actions={selector}
            actionsRightOnDesktop
            description="Creates an unpublished prompt revision."
            eyebrow={
              <BackLink
                className="underline underline-offset-4"
                href={`${workspaceAgentsPath(workspaceSlug, { ...directoryQuery, after })}#new-agent`}
              >
                Back to agents
              </BackLink>
            }
            eyebrowAsPlain
            title={
              <h1
                className={`${PAGE_HEADER_TITLE_CLASS} scroll-mt-24`}
                id="new-agent"
                tabIndex={-1}
              >
                New agent
              </h1>
            }
            titleAsChild
          />
          <FactoryAuthoringFocus target="new-agent" />
          <AgentPromptForm
            factoryId={factory.id}
            form={{ kind: "create" }}
            key={factory.id}
            listQuery={{ q, after }}
            workspaceId={workspaceId}
            workspaceSlug={workspaceSlug}
          />
        </PageContainer>
      </AgentDirectoryDraftScope>
    );
  }

  const { agents, nextAfterId, implementationAgentId, usesFactoryDefault } = await loadAgentsList(
    scope,
    { afterId: after, search: q },
  );
  const empty = !agents.length && !q && !after;
  const newAgent = canEditPrompt ? (
    <Link
      className="ui-button ui-button-primary"
      href={`${workspaceAgentsPath(workspaceSlug, { ...directoryQuery, after, new: "1" })}#new-agent`}
      id="new-agent"
    >
      New agent
    </Link>
  ) : null;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title="Agents"
        actions={
          <>
            {selector}
            {!empty ? newAgent : null}
          </>
        }
        actionsRightOnDesktop
      />
      {newAgent ? <FactoryAuthoringFocus target="new-agent" /> : null}
      <div className="space-y-8">
        <section aria-label="Factory agents" className="ui-sheet divide-y divide-border">
          {!empty && (
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
          )}
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
            <div className="space-y-3 px-4 py-5 sm:px-5">
              <p className="type-secondary text-muted">
                {after
                  ? "No more agents on this page."
                  : q
                    ? "No matching agents."
                    : "No agents in this factory yet."}
              </p>
              {empty ? newAgent : null}
            </div>
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
      </div>
    </PageContainer>
  );
}
