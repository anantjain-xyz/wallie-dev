import { MemoryPageView } from "@/features/factory-content/memory-page-view";
import { loadMemoryPage, parseMemoryQuery } from "@/features/factory-content/content-data";
import { loadGovernanceScope } from "@/features/factory-governance/governance-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";

export default async function MemoryPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, { factory, ...rawQuery }] = await Promise.all([params, searchParams]);
  const scope = await loadGovernanceScope(workspaceSlug, factory);
  if (!scope) return <FactoryUnavailable title="Memory" workspaceSlug={workspaceSlug} />;
  const parsed = parseMemoryQuery(rawQuery);
  const data = parsed.success ? await loadMemoryPage(scope, parsed.data) : null;
  return <MemoryPageView scope={scope} data={data} query={parsed.success ? parsed.data : {}} />;
}
