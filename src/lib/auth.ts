import type { User } from "@supabase/supabase-js";

import { onboardingWorkspacePath, workspaceBasePath } from "@/lib/routes";
import type { Database } from "@/lib/supabase/database.types";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const redirectOrigin = "https://wallie.cc";

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
) {
  const { data, error } = await supabase
    .from("workspaces")
    .select("id, name, slug")
    .eq("slug", workspaceSlug)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data satisfies WorkspaceSummary | null;
}

export async function hasAnyWorkspaceForUser(supabase: SupabaseServerClient) {
  return (await getDefaultWorkspace(supabase)) !== null;
}

export async function resolveAuthenticatedHomePath(supabase: SupabaseServerClient) {
  const workspace = await getDefaultWorkspace(supabase);

  return workspace ? workspaceBasePath(workspace.slug) : onboardingWorkspacePath();
}
