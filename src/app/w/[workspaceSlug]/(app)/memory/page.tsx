import Link from "next/link";

import { scopeFactoryIndex } from "@/components/app-shell/workspace-factory-page.server";
import { PageContainer, PageHeader } from "@/components/ui/page-shell";
import { MemoryPageView } from "@/features/factory-content/memory-page-view";
import { loadMemoryPage, parseMemoryQuery } from "@/features/factory-content/content-data";
import { loadWorkspaceFactoryOptions } from "@/features/factories/factory-options-data";
import { FactorySelector } from "@/features/factories/factory-selector";
import { loadGovernanceScope } from "@/features/factory-governance/governance-data";
import { workspaceMemoryPath } from "@/lib/routes";

const MEMORY_FACTORY_RESET_PARAMS = [
  "memory",
  "revision",
  "decision",
  "proposal",
  "version",
  "q",
  "before",
] as const;

async function MemoryPage({
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
  const activeFactory = managedFactories.find(({ status }) => status === "active");
  const availableFactory = activeFactory ?? managedFactories[0];
  if (!scope)
    return (
      <PageContainer className="pt-5 sm:pt-10">
        <PageHeader
          actions={
            availableFactory && (
              <FactorySelector
                factories={managedFactories}
                resetParams={MEMORY_FACTORY_RESET_PARAMS}
                selectedValue="unavailable"
              />
            )
          }
          actionsRightOnDesktop
          title="Memory"
        />
        <section aria-labelledby="memory-unavailable" className="ui-sheet space-y-3 p-4 sm:p-5">
          <h2 className="type-label" id="memory-unavailable">
            Factory memory unavailable
          </h2>
          <p className="type-secondary text-muted">
            Memory requires factory manager access.{" "}
            {availableFactory
              ? "Choose a factory you manage."
              : "Ask a workspace admin for access if you need to review memory."}
          </p>
          {availableFactory && (
            <Link
              className="ui-button"
              href={workspaceMemoryPath(workspaceSlug, { factory: availableFactory.id })}
            >
              Open available memory
            </Link>
          )}
        </section>
      </PageContainer>
    );
  const parsed = parseMemoryQuery(rawQuery);
  const data = parsed.success ? await loadMemoryPage(scope, parsed.data) : null;
  return (
    <MemoryPageView
      activeFactory={activeFactory}
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

export default scopeFactoryIndex(MemoryPage, {
  route: "memory",
  title: "Memory",
  resetParams: MEMORY_FACTORY_RESET_PARAMS,
});
