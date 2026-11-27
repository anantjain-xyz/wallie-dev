import { WorkspaceResourceScope } from "@/components/app-shell/workspace-factory-page.server";
import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import { PageContainer, PageHeader, PageSection } from "@/components/ui/page-shell";
import { AgentBindings } from "@/features/factory-agents/agent-bindings";
import { AgentFactoryRecovery } from "@/features/factory-agents/agent-factory-recovery";
import {
  agentIdParam,
  agentListQuery,
  agentPromptPath,
  agentRevisionRunsPath,
} from "@/features/factory-agents/agent-navigation";
import { loadAgentDetail, loadAgentPageScope } from "@/features/factory-agents/agent-pages-data";
import { AgentPromptForm } from "@/features/factory-agents/agent-prompt-form";
import { TechnicalId } from "@/features/factory-agents/technical-id";
import {
  workspaceAgentDetailPath,
  workspaceAgentsPath,
  workspaceFactoryDefinitionPath,
  workspaceGovernancePath,
} from "@/lib/routes";

const revisionNumber = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().safe());
const revisionDate = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" });

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; agentId: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    revision?: string | string[];
    before?: string | string[];
    q?: string | string[];
    after?: string | string[];
  }>;
}) {
  const [{ workspaceSlug, agentId }, query] = await Promise.all([params, searchParams]);
  const agentKey = agentIdParam.safeParse(agentId);
  const selectedKey = agentIdParam.optional().safeParse(query.revision);
  const before = revisionNumber.optional().safeParse(query.before);
  if (!agentKey.success || !selectedKey.success || !before.success) notFound();

  const { scope, selection, factories } = await loadAgentPageScope(workspaceSlug, query.factory);
  if (!scope)
    return (
      <AgentFactoryRecovery
        choose={selection === "choose"}
        factories={factories}
        workspaceSlug={workspaceSlug}
      />
    );
  const data = await loadAgentDetail(scope, {
    agentId: agentKey.data,
    revisionId: selectedKey.data,
    before: before.data,
  });
  if (!data) notFound();

  const {
    agent,
    bindings,
    hasPublishedDefinition,
    usesFactoryDefault,
    publishedPrompt,
    latest,
    selected,
    revisions,
    nextBeforeRevisionNumber,
  } = data;
  const { factory, canEditDefinition, canEditPrompt } = scope;
  const factoryQuery = { factory: factory.id };
  const listQuery = agentListQuery(query);
  const detailQuery = { ...factoryQuery, ...listQuery };
  const configHref =
    selected && canEditDefinition
      ? workspaceFactoryDefinitionPath(workspaceSlug, {
          ...factoryQuery,
          implementationAgent: selected.id,
        })
      : null;
  const readinessHref =
    bindings && canEditDefinition
      ? `${workspaceFactoryDefinitionPath(workspaceSlug, { ...factoryQuery, revision: bindings.revisionId })}#execution-profile`
      : null;
  const publishedPromptHref =
    publishedPrompt && publishedPrompt.id !== selected?.id
      ? agentPromptPath(workspaceSlug, agent.id, { ...detailQuery, revision: publishedPrompt.id })
      : null;
  const authority = bindings?.profile.credentialAuthority;
  const grantHref =
    factory.canManage && authority?.kind === "service" && bindings?.grant
      ? workspaceGovernancePath(workspaceSlug, { ...factoryQuery, grant: authority.grantId })
      : null;
  const runsHref = selected
    ? agentRevisionRunsPath(workspaceSlug, factory.id, agent.id, selected.id)
    : null;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <WorkspaceResourceScope
        factoryId={factory.id}
        pathname={workspaceAgentDetailPath(workspaceSlug, agentId)}
        workspaceSlug={workspaceSlug}
      />
      <PageHeader
        title={agent.name}
        description={`${factory.name} · ${agent.slug}`}
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={workspaceAgentsPath(workspaceSlug, detailQuery)}
          >
            ← Agents
          </Link>
        }
        eyebrowAsPlain
      />
      <div className="space-y-8">
        <AgentBindings
          bindings={bindings}
          archived={factory.status === "archived"}
          canEditDefinition={canEditDefinition}
          grantHref={grantHref}
          hasPublishedDefinition={hasPublishedDefinition}
          isDefault={agent.is_default}
          publishedPromptNumber={publishedPrompt?.revision_number}
          publishedPromptHref={publishedPromptHref}
          readinessHref={readinessHref}
          usesFactoryDefault={usesFactoryDefault}
        />
        <div className="scroll-mt-8" id="prompt-revision" tabIndex={-1}>
          <PageSection
            title={selected ? `Prompt revision ${selected.revision_number}` : "Prompt revision"}
            actions={
              <>
                {configHref && (
                  <Link className="ui-button" href={configHref}>
                    Configure bindings
                  </Link>
                )}
                {runsHref && (
                  <Link className="ui-button" href={runsHref}>
                    View runs for this revision
                  </Link>
                )}
              </>
            }
            tagline={
              selected ? (
                <>
                  Published:{" "}
                  {publishedPrompt
                    ? `Revision ${publishedPrompt.revision_number}`
                    : bindings
                      ? "Revision unavailable"
                      : "None for this agent"}
                  {" · "}Viewing: Revision {selected.revision_number}
                  {selected.id !== publishedPrompt?.id &&
                    (agent.is_default && selected.revision_number === 1
                      ? " (factory default)"
                      : " (saved only)")}
                </>
              ) : undefined
            }
          >
            {selected ? (
              <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
                {selected.prompt_md ? (
                  <pre className="whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">
                    {selected.prompt_md}
                  </pre>
                ) : (
                  <p className="type-secondary text-muted">Empty prompt.</p>
                )}
                <TechnicalId label="Revision ID" value={selected.id} />
              </div>
            ) : (
              <p className="type-secondary text-muted">No prompt revisions on this page.</p>
            )}
          </PageSection>
        </div>
        {canEditPrompt && latest && (
          <PageSection anchorId="new-prompt-revision" title="Create a prompt revision">
            <AgentPromptForm
              factoryId={factory.id}
              form={{
                kind: "revise",
                agentId: agent.id,
                prompt: latest.prompt_md,
                revision: latest.revision_number,
              }}
              key={`${factory.id}:${agent.id}`}
              listQuery={listQuery}
              workspaceId={scope.workspaceId}
              workspaceSlug={workspaceSlug}
            />
          </PageSection>
        )}
        <PageSection title="Prompt history">
          {revisions.length ? (
            <ul className="ui-sheet divide-y divide-border">
              {revisions.map((revision) => (
                <li
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-5"
                  key={revision.id}
                >
                  <Link
                    aria-current={revision.id === selected?.id ? "true" : undefined}
                    className="font-semibold text-foreground underline-offset-4 hover:text-accent hover:underline"
                    href={agentPromptPath(workspaceSlug, agent.id, {
                      ...detailQuery,
                      before: before.data,
                      revision: revision.id,
                    })}
                  >
                    Revision {revision.revision_number}
                  </Link>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
                    {revision.id === publishedPrompt?.id && (
                      <span className="type-label">Published</span>
                    )}
                    {revision.id === latest?.id && <span className="type-label">Latest saved</span>}
                    {agent.is_default && revision.revision_number === 1 && (
                      <span className="type-label">Factory default</span>
                    )}
                    <time className="type-annotation" dateTime={revision.created_at}>
                      {revisionDate.format(new Date(revision.created_at))}
                    </time>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-secondary text-muted">No prompt revisions on this page.</p>
          )}
          {before.data || nextBeforeRevisionNumber ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {before.data && (
                <Link
                  className="ui-button"
                  href={workspaceAgentDetailPath(workspaceSlug, agent.id, {
                    ...detailQuery,
                    revision: selected?.id,
                  })}
                >
                  Latest revisions
                </Link>
              )}
              {nextBeforeRevisionNumber && (
                <Link
                  className="ui-button"
                  href={workspaceAgentDetailPath(workspaceSlug, agent.id, {
                    ...detailQuery,
                    before: nextBeforeRevisionNumber,
                    revision: selected?.id,
                  })}
                >
                  Older revisions
                </Link>
              )}
            </div>
          ) : null}
        </PageSection>
      </div>
    </PageContainer>
  );
}
