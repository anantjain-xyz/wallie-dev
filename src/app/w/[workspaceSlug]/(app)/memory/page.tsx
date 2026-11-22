import { MemoryPageView } from "@/features/factory-content/memory-page-view";
import { loadMemoryPage, parseMemoryQuery } from "@/features/factory-content/content-data";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadGovernanceScope } from "@/features/factory-governance/governance-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";

const MEMORY_FACTORY_RESET_PARAMS = [
  "memory",
  "revision",
  "decision",
  "proposal",
  "version",
  "before",
] as const;

export default async function MemoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, { factory, ...rawQuery }] = await Promise.all([params, searchParams]);
  const [scope, factories] = await Promise.all([
    loadGovernanceScope(workspaceSlug, factory),
    loadWorkspaceFactoryOptions(workspaceSlug),
  ]);
  const managedFactories = factories.filter(({ canManage }) => canManage);
  if (!scope)
    return (
      <FactoryUnavailable
        actions={
          <FactorySelector
            factories={managedFactories}
            resetParams={MEMORY_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Memory"
        workspaceSlug={workspaceSlug}
      />
    );
  const parsed = parseMemoryQuery(rawQuery);
  const data = parsed.success ? await loadMemoryPage(scope, parsed.data) : null;
  return (
    <MemoryPageView
      data={data}
      factorySelector={
        <FactorySelector
          factories={managedFactories}
          resetParams={MEMORY_FACTORY_RESET_PARAMS}
          selectedValue={scope.factory.id}
        />
      }
      query={parsed.success ? parsed.data : {}}
      scope={scope}
    />
  );
}
