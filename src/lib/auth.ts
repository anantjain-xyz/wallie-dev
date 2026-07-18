import type { User } from "@supabase/supabase-js";

import { resolveAppOrigin } from "@/lib/app-url";
import { onboardingWorkspacePath, workspaceBasePath, workspaceSettingsPath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type SupabaseServerClient = Awaited<ReturnType<typeof createSupabaseServerClient>>;

export type WorkspaceSummary = Pick<
  Database["public"]["Tables"]["workspaces"]["Row"],
  "id" | "name" | "slug"
>;

type UserMetadata = {
  avatar_url?: string;
  full_name?: string;
  name?: string;
  picture?: string;
};

export function normalizeNextPath(value: string | null | undefined, fallback = "/") {
  if (!value) {
    return fallback;
  }

  try {
    const redirectOrigin = resolveAppOrigin();
    const parsed = new URL(value, redirectOrigin);

    if (parsed.origin !== redirectOrigin) {
      return fallback;
    }

    if (!parsed.pathname.startsWith("/")) {
      return fallback;
    }

    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function workspaceLoginRedirectPath(workspaceSlug: string) {
  return normalizeNextPath(workspaceBasePath(workspaceSlug));
}

export async function ensureProfileForUser(supabase: SupabaseServerClient, user: User) {
  const metadata = (user.user_metadata ?? {}) as UserMetadata;
  const fullName = metadata.full_name ?? metadata.name ?? null;
  const avatarUrl = metadata.avatar_url ?? metadata.picture ?? null;

  const { error } = await supabase.from("profiles").upsert(
    {
      avatar_url: avatarUrl,
      full_name: fullName,
      id: user.id,
      primary_email: user.email ?? null,
    },
    {
      onConflict: "id",
    },
  );

  if (error) {
    throw error;
  }
}

export async function getDefaultWorkspace(supabase: SupabaseServerClient) {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data satisfies WorkspaceSummary | null;
}

export async function getWorkspaceBySlugForUser(
  supabase: SupabaseServerClient,
  workspaceSlug: string,
  userId: string,
) {
  const { data, error } = await supabase
    .from("workspaces")
    .select(
      "id, name, slug, avatar_path, current_member:workspace_members!inner(id, role, is_active, kind)",
    )
    .eq("slug", workspaceSlug)
    .eq("current_member.user_id", userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) return null;

  const [currentMember] = data.current_member;
  if (!currentMember) return null;

  return {
    currentMember,
    workspace: {
      avatar_path: data.avatar_path,
      id: data.id,
      name: data.name,
      slug: data.slug,
    },
  } satisfies {
    currentMember: Pick<
      Database["public"]["Tables"]["workspace_members"]["Row"],
      "id" | "is_active" | "kind" | "role"
    >;
    workspace: WorkspaceSummary & { avatar_path: string | null };
  };
}

export async function hasAnyWorkspaceForUser(supabase: SupabaseServerClient) {
  return (await getDefaultWorkspace(supabase)) !== null;
}

export async function resolveAuthenticatedHomePath(supabase: SupabaseServerClient) {
  const workspace = await getDefaultWorkspace(supabase);

  return workspace ? workspaceBasePath(workspace.slug) : onboardingWorkspacePath();
}

export async function resolveAuthenticatedSettingsPath(supabase: SupabaseServerClient) {
  const workspace = await getDefaultWorkspace(supabase);

  return workspace ? workspaceSettingsPath(workspace.slug) : onboardingWorkspacePath();
}
