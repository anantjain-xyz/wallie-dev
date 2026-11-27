import type { SandboxProvider } from "@/lib/sandbox/types";

import type { CompiledFactoryDefinition } from "./compiler";

type SetupBlocker =
  | "definition_unpublished"
  | "repository_unavailable"
  | "pipeline_unavailable"
  | "sandbox_unavailable";

export function serialFactorySetupBlockers({
  definition,
  repositoryIds,
  pipelineAvailable,
  connectedSandboxProviders,
}: {
  definition: Pick<CompiledFactoryDefinition, "repositoryId" | "sandboxProvider"> | null;
  repositoryIds: readonly string[];
  pipelineAvailable: boolean;
  connectedSandboxProviders: readonly SandboxProvider[];
}): SetupBlocker[] {
  if (!definition) return ["definition_unpublished"];
  const blockers: SetupBlocker[] = [];
  if (!repositoryIds.includes(definition.repositoryId)) blockers.push("repository_unavailable");
  if (!pipelineAvailable) blockers.push("pipeline_unavailable");
  if (!connectedSandboxProviders.includes(definition.sandboxProvider))
    blockers.push("sandbox_unavailable");
  return blockers;
}
