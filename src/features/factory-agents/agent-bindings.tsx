import Link from "next/link";

import { ExecutionProfileFields } from "@/components/shared/execution-profile-fields";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";

import type { PublishedAgentBindings } from "./agent-pages-data";

function RepositoryNames({ repositories }: { repositories: { id: string; name: string }[] }) {
  return repositories.length ? (
    <ul className="space-y-1 [overflow-wrap:anywhere]">
      {repositories.map((repository) => (
        <li key={repository.id}>{repository.name}</li>
      ))}
    </ul>
  ) : (
    "None"
  );
}

export function AgentBindings({
  bindings,
  publishedPromptHref,
  readinessHref,
}: {
  bindings: PublishedAgentBindings | null;
  publishedPromptHref: string | null;
  readinessHref: string | null;
}) {
  if (!bindings)
    return (
      <PageSection anchorId="published-bindings" title="Published bindings">
        <p className="type-secondary text-muted">This agent has no published bindings.</p>
      </PageSection>
    );

  const { profile, repositories, skills, tools } = bindings;
  const authority = profile.credentialAuthority;
  return (
    <PageSection
      anchorId="published-bindings"
      title="Published bindings"
      actions={
        readinessHref ? (
          <Link className="ui-button" href={readinessHref}>
            Review readiness
          </Link>
        ) : undefined
      }
    >
      <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
        <MetadataList>
          {publishedPromptHref && (
            <MetadataItem
              label="Implementation prompt"
              value={
                <Link
                  className="underline underline-offset-4 hover:text-accent"
                  href={publishedPromptHref}
                >
                  View published prompt
                </Link>
              }
            />
          )}
          <ExecutionProfileFields profile={profile} />
          <MetadataItem
            label="Credential authority"
            value={authority.kind === "human" ? "Session creator" : "Service principal"}
          />
          {authority.kind === "service" && (
            <MetadataItem
              label="Execution grant"
              value={
                <span className="[overflow-wrap:anywhere]">
                  {authority.grantId} · v{authority.grantVersion}
                </span>
              }
            />
          )}
          <MetadataItem
            label="Writable repositories"
            value={<RepositoryNames repositories={repositories.writable} />}
          />
          <MetadataItem
            label="Read-only repositories"
            value={<RepositoryNames repositories={repositories.context} />}
          />
          <MetadataItem
            label="Skills"
            value={
              skills.length ? (
                <ul className="space-y-1 [overflow-wrap:anywhere]">
                  {skills.map((skill) => (
                    <li key={skill.id}>
                      {skill.name} · v{skill.version}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )
            }
          />
          <MetadataItem
            label="MCP tools"
            value={
              tools.length ? (
                <ul className="space-y-1 [overflow-wrap:anywhere]">
                  {tools.map((tool) => (
                    <li key={tool.serverId}>
                      {tool.serverSlug} · v{tool.revisionNumber} · {tool.operations.join(", ")}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )
            }
          />
        </MetadataList>
        {profile.unavailableReason && (
          <p className="type-secondary text-muted">{profile.unavailableReason}</p>
        )}
      </div>
    </PageSection>
  );
}
