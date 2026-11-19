import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";

import {
  MetadataItem,
  MetadataList,
  PageContainer,
  PageHeader,
  PageSection,
} from "@/components/ui/page-shell";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";
import { AgentBindings } from "@/features/factory-agents/agent-bindings";
import { loadAgentDetail, loadAgentPageScope } from "@/features/factory-agents/agent-pages-data";
import { AgentPromptForm } from "@/features/factory-agents/agent-prompt-form";
import {
  workspaceAgentDetailPath,
  workspaceAgentsPath,
  workspaceFactoryDefinitionPath,
} from "@/lib/routes";

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const revisionNumber = z
  .string()
  .regex(/^[1-9]\d*$/)
  .transform(Number)
  .pipe(z.number().int().safe());

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string; agentId: string }>;
  searchParams: Promise<{
    factory?: string | string[];
    revision?: string | string[];
    before?: string | string[];
  }>;
}) {
  const [{ workspaceSlug, agentId }, query] = await Promise.all([params, searchParams]);
  const agentKey = uuid.safeParse(agentId);
  const selectedKey = uuid.optional().safeParse(query.revision);
  const before = revisionNumber.optional().safeParse(query.before);
  if (!agentKey.success || !selectedKey.success || !before.success) notFound();

  const scope = await loadAgentPageScope(workspaceSlug, query.factory);
  if (!scope) return <FactoryUnavailable title="Agents" />;
  const data = await loadAgentDetail(scope, {
    agentId: agentKey.data,
    revisionId: selectedKey.data,
    before: before.data,
  });
  if (!data) notFound();

  const { agent, bindings, latest, selected, revisions, nextBeforeRevisionNumber } = data;
  const { factory, canEditDefinition, canEditPrompt } = scope;
  const factoryQuery = { factory: factory.id };
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
    bindings?.promptRevisionId && bindings.promptRevisionId !== selected?.id
      ? `${workspaceAgentDetailPath(workspaceSlug, agent.id, { ...factoryQuery, revision: bindings.promptRevisionId })}#prompt-revision`
      : null;

  return (
    <PageContainer className="pt-5 sm:pt-10">
      <PageHeader
        title={agent.name}
        description={`${factory.name} · ${agent.slug}`}
        eyebrow={
          <Link
            className="hover:text-foreground"
            href={workspaceAgentsPath(workspaceSlug, factoryQuery)}
          >
            ← Agents
          </Link>
        }
        eyebrowAsPlain
      />
      <div className="space-y-8">
        <AgentBindings
          bindings={bindings}
          publishedPromptHref={publishedPromptHref}
          readinessHref={readinessHref}
        />
        <PageSection
          anchorId="prompt-revision"
          title={selected ? `Prompt revision ${selected.revision_number}` : "Prompt revision"}
          actions={
            configHref ? (
              <Link className="ui-button" href={configHref}>
                Configure bindings
              </Link>
            ) : undefined
          }
        >
          {selected ? (
            <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
              <MetadataList>
                <MetadataItem
                  label="Revision ID"
                  monospace
                  value={<span className="[overflow-wrap:anywhere]">{selected.id}</span>}
                />
                <MetadataItem
                  label="Publication"
                  value={
                    bindings?.promptRevisionId === selected.id
                      ? "Published implementation prompt"
                      : "Saved prompt revision"
                  }
                />
              </MetadataList>
              {selected.prompt_md ? (
                <pre className="whitespace-pre-wrap text-sm text-foreground [overflow-wrap:anywhere]">
                  {selected.prompt_md}
                </pre>
              ) : (
                <p className="type-secondary text-muted">Empty prompt.</p>
              )}
            </div>
          ) : (
            <p className="type-secondary text-muted">No prompt revisions on this page.</p>
          )}
        </PageSection>
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
              key={latest.id}
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
                    href={workspaceAgentDetailPath(workspaceSlug, agent.id, {
                      ...factoryQuery,
                      before: before.data,
                      revision: revision.id,
                    })}
                  >
                    Revision {revision.revision_number}
                  </Link>
                  {revision.id === bindings?.promptRevisionId && (
                    <span className="type-label text-muted">Published</span>
                  )}
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
                  href={workspaceAgentDetailPath(workspaceSlug, agent.id, factoryQuery)}
                >
                  Latest revisions
                </Link>
              )}
              {nextBeforeRevisionNumber && (
                <Link
                  className="ui-button"
                  href={workspaceAgentDetailPath(workspaceSlug, agent.id, {
                    ...factoryQuery,
                    before: nextBeforeRevisionNumber,
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
