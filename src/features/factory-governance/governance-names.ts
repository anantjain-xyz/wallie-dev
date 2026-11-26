import type { GovernanceData } from "./governance-data";

export function principalName(data: GovernanceData, id: string) {
  return (
    data.evidence.principals.find((row) => row.id === id)?.name ??
    data.principalList.entries.find((row) => row.id === id)?.name
  );
}

export function repositoryName(data: GovernanceData, id: string) {
  const row = data.evidence.repositories.find((repository) => repository.id === id);
  return row
    ? `${row.full_name}${row.is_archived ? " (archived)" : ""}`
    : data.repositoryOptions.find((repository) => repository.id === id)?.label;
}

export function grantName(
  data: GovernanceData,
  grant: {
    service_principal_id: string;
    github_repository_id: string;
  },
) {
  return `${principalName(data, grant.service_principal_id) ?? "Service principal unavailable"} · ${repositoryName(data, grant.github_repository_id) ?? "Repository unavailable"}`;
}

export function toolName(data: GovernanceData, id: string) {
  const [revisionId, operation] = id.split("/");
  const revision = data.evidence.toolRevisions.find((tool) => tool.id === revisionId);
  if (!revision || (operation && !revision.operation_names.includes(operation))) return undefined;
  return `${revision.factory_mcp_servers.name} · v${revision.revision_number}${operation ? ` · ${operation}` : ""}`;
}
