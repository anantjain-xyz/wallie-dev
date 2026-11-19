import { ContextPageView } from "@/features/factory-content/context-page-view";
import { loadContextPage, parseContextQuery } from "@/features/factory-content/content-data";
import { loadGovernanceScope } from "@/features/factory-governance/governance-data";
import { FactoryUnavailable } from "@/features/factories/factory-unavailable";

export default async function ContextPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceSlug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ workspaceSlug }, { factory, ...rawQuery }] = await Promise.all([params, searchParams]);
  const scope = await loadGovernanceScope(workspaceSlug, factory);
  if (!scope) return <FactoryUnavailable title="Context" />;
  const parsed = parseContextQuery(rawQuery);
  const data = parsed.success ? await loadContextPage(scope, parsed.data) : null;
  return <ContextPageView scope={scope} data={data} query={parsed.success ? parsed.data : {}} />;
}
