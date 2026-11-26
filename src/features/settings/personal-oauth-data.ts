import "server-only";

import type { AuthenticatedWorkspaceContext } from "@/features/workspaces/authenticated-context";

const pageSize = 20;

export async function loadPersonalOAuthConnections({
  afterGrantId,
  history,
  memberId,
  supabase,
  workspaceId,
}: {
  afterGrantId?: string;
  history: boolean;
  memberId: string;
  supabase: AuthenticatedWorkspaceContext["supabase"];
  workspaceId: string;
}) {
  const asOf = new Date().toISOString();
  const scopedGrants = () =>
    supabase
      .from("factory_oauth_grants")
      .select(
        "id, created_at, expires_at, revoked_at, scopes, factory_oauth_clients(name), factory_oauth_grant_bindings(factory_id, scopes)",
      )
      .eq("workspace_id", workspaceId)
      .eq("consenting_member_id", memberId);

  let query = scopedGrants()
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(pageSize + 1);
  if (history) {
    query = query.or(`revoked_at.not.is.null,expires_at.lte.${asOf}`);
  } else {
    query = query.is("revoked_at", null).gt("expires_at", asOf);
  }
  if (afterGrantId) {
    const { data: cursor, error } = await scopedGrants().eq("id", afterGrantId).maybeSingle();
    if (error) throw error;
    if (cursor) {
      query = query.or(
        `created_at.lt.${cursor.created_at},and(created_at.eq.${cursor.created_at},id.lt.${cursor.id})`,
      );
    }
  }

  const { data, error } = await query;
  if (error) throw error;
  const page = data.slice(0, pageSize);
  const factoryIds = [
    ...new Set(
      page.flatMap((grant) =>
        grant.factory_oauth_grant_bindings.map((binding) => binding.factory_id),
      ),
    ),
  ];
  const factories = factoryIds.length
    ? await supabase
        .from("factories")
        .select("id, name")
        .eq("workspace_id", workspaceId)
        .in("id", factoryIds)
    : null;
  if (factories?.error) throw factories.error;
  const factoryNames = new Map(factories?.data?.map(({ id, name }) => [id, name]));

  return {
    grants: page.map((grant) => ({
      id: grant.id,
      clientName: grant.factory_oauth_clients?.name ?? "Client name unavailable",
      connectedAt: grant.created_at,
      expiresAt: grant.expires_at,
      status: grant.revoked_at
        ? ("Disconnected" as const)
        : history
          ? ("Expired" as const)
          : ("Active" as const),
      scopes: grant.scopes,
      factories: grant.factory_oauth_grant_bindings
        .map((binding) => ({
          id: binding.factory_id,
          name: factoryNames.get(binding.factory_id) ?? "Unavailable factory",
          scopes: binding.scopes,
        }))
        .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
    })),
    next: data.length > pageSize ? page.at(-1)?.id : undefined,
  };
}

export type PersonalOAuthGrant = Awaited<
  ReturnType<typeof loadPersonalOAuthConnections>
>["grants"][number];
