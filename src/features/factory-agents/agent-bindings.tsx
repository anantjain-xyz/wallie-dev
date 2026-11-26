import Link from "next/link";

import { ExecutionProfileFields } from "@/components/shared/execution-profile-fields";
import { MetadataItem, MetadataList, PageSection } from "@/components/ui/page-shell";

import type { PublishedAgentBindings } from "./agent-pages-data";
import { TechnicalId } from "./technical-id";

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
  archived,
  canEditDefinition,
  grantHref,
  hasPublishedDefinition,
  isDefault,
  publishedPromptNumber,
  publishedPromptHref,
  readinessHref,
  usesFactoryDefault,
}: {
  bindings: PublishedAgentBindings | null;
  archived: boolean;
  canEditDefinition: boolean;
  grantHref: string | null;
  hasPublishedDefinition: boolean;
  isDefault: boolean;
  publishedPromptNumber: number | undefined;
  publishedPromptHref: string | null;
  readinessHref: string | null;
  usesFactoryDefault: boolean;
}) {
  if (!bindings)
    return (
      <PageSection anchorId="published-bindings" title="Published bindings">
        <div className="ui-sheet space-y-2 p-4 sm:p-5">
          <p className="font-semibold text-foreground">
            {hasPublishedDefinition
              ? "This agent is not selected in the published definition"
              : "No definition published"}
          </p>
          {!hasPublishedDefinition && isDefault && (
            <p className="type-secondary text-muted">
              Legacy execution without a pinned implementation prompt uses this factory default’s
              initial prompt (Revision 1), not its latest saved revision.
            </p>
          )}
          <p className="type-secondary text-muted">
            {archived
              ? "This archived factory keeps prompt history but cannot publish changes."
              : canEditDefinition
                ? "To use this agent, configure a saved revision below, then publish from Factory Definition."
                : "A workspace operator can choose a prompt and publish a definition."}
          </p>
        </div>
      </PageSection>
    );

  const { grant, profile, repositories, skills, tools } = bindings;
  const authority = profile.credentialAuthority;
  const grantVersionChanged =
    authority.kind === "service" && grant && grant.version !== authority.grantVersion;
  const grantIssue = grant?.status
    ? `The execution grant is ${grant.status.toLowerCase()}.`
    : grantVersionChanged
      ? "The current execution grant version differs from the published binding."
      : null;
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
        <div className="space-y-2 border-b border-border pb-4">
          <p className="font-semibold text-foreground">
            {archived ? "Last published binding" : "Published for new sessions"}
            {publishedPromptNumber
              ? ` · Revision ${publishedPromptNumber}`
              : " · Prompt revision unavailable"}
            {usesFactoryDefault && " (factory default)"}
          </p>
          <p className="type-secondary text-muted">
            {archived
              ? "This factory is archived. Readiness not checked on this page."
              : readinessHref
                ? "Readiness not checked on this page. Review readiness in Factory Definition to check credentials and repository access."
                : "Readiness not checked on this page. A workspace operator can check credentials and repository access in Factory Definition."}
          </p>
          {[profile.unavailableReason, grantIssue].filter(Boolean).map((issue) => (
            <p className="type-secondary text-danger" key={issue}>
              Known configuration issue: {issue}
            </p>
          ))}
        </div>
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
            value={
              authority.kind === "human"
                ? "Session creator"
                : (grant?.principal ?? "Service principal")
            }
          />
          {authority.kind === "service" && (
            <MetadataItem
              label="Execution grant"
              value={
                <div className="space-y-2 [overflow-wrap:anywhere]">
                  <p>
                    {grant?.principal && !grantVersionChanged
                      ? `${grant.principal} · ${grant.repository ?? "Writable repository unavailable"} · Grant v${authority.grantVersion}`
                      : `Grant details unavailable · v${authority.grantVersion}`}
                  </p>
                  {grantHref && (
                    <Link
                      className="underline underline-offset-4 hover:text-accent"
                      href={grantHref}
                    >
                      View grant in Governance
                    </Link>
                  )}
                  {grantHref && <TechnicalId label="Grant ID" value={authority.grantId} />}
                </div>
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
                      {tool.name && tool.name !== tool.serverSlug ? (
                        <>
                          {tool.name} · v{tool.revisionNumber}
                          <p className="type-annotation text-muted" translate="no">
                            {tool.serverSlug} · {tool.operations.join(", ")}
                          </p>
                        </>
                      ) : (
                        <span translate="no">
                          {tool.serverSlug} · v{tool.revisionNumber} · {tool.operations.join(", ")}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                "None"
              )
            }
          />
        </MetadataList>
      </div>
    </PageSection>
  );
}
