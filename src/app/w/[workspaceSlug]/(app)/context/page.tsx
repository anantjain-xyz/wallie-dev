import { ContextPageView } from "@/features/factory-content/context-page-view";
import { loadContextPage, parseContextQuery } from "@/features/factory-content/content-data";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadGovernanceScope } from "@/features/factory-governance/governance-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";

const CONTEXT_FACTORY_RESET_PARAMS = [
  "source",
  "revision",
  "version",
  "before",
  "grantAfter",
  "repoAfter",
] as const;

export default async function ContextPage({
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
            resetParams={CONTEXT_FACTORY_RESET_PARAMS}
            selectedValue="unavailable"
          />
        }
        title="Context"
        workspaceSlug={workspaceSlug}
      />
    );
  const parsed = parseContextQuery(rawQuery);
  const data = parsed.success ? await loadContextPage(scope, parsed.data) : null;
  return (
    <ContextPageView
      data={data}
      factorySelector={
        <FactorySelector
          factories={managedFactories}
          resetParams={CONTEXT_FACTORY_RESET_PARAMS}
          selectedValue={scope.factory.id}
        />
      }
      query={parsed.success ? parsed.data : {}}
      scope={scope}
    />
  );
}
