import type { CompiledFactoryDefinition } from "./compiler";

export function factoryWritableRepositoryIds(
  definition: Pick<CompiledFactoryDefinition, "repositoryId" | "writableRepositoryIds">,
) {
  return [definition.repositoryId, ...(definition.writableRepositoryIds ?? [])];
}
