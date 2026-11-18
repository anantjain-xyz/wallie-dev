import { useState, type ComponentProps } from "react";

import { SandboxCapabilitySection } from "@/features/settings/sandbox-capability-section";
import type { FactoryEditorDocument } from "@/lib/factory-definitions/editor-contracts";
import { factoryWritableRepositoryIds } from "@/lib/factory-definitions/repository-bindings";

type FactoryCapabilityProbeProps = Pick<
  ComponentProps<typeof SandboxCapabilitySection>,
  "canManage" | "repositories" | "sandboxConnected" | "setFlashMessage" | "workspaceId"
> & { target: FactoryEditorDocument };

export function FactoryCapabilityProbe({
  repositories,
  target,
  ...props
}: FactoryCapabilityProbeProps) {
  const [repositoryId, setRepositoryId] = useState(target.bundle.repositoryId);
  const writableIds = factoryWritableRepositoryIds(target.bundle);
  const writableRepositories = repositories.filter(({ id }) => writableIds.includes(id));

  return (
    <SandboxCapabilitySection
      {...props}
      definitionTarget={{ id: target.id, kind: target.kind, repositoryId }}
      initialCheck={null}
      onDefinitionRepositoryChange={writableIds.length > 1 ? setRepositoryId : undefined}
      repositories={writableRepositories}
    />
  );
}
