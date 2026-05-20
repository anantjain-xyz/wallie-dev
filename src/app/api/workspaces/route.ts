import { NextResponse } from "next/server";

import { ensureProfileForUser } from "@/lib/auth";
import { workspaceOnboardingPath } from "@/lib/routes";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createWorkspaceInputSchema, normalizeWorkspaceSlug } from "@/lib/workspaces";

function getUserMetadataString(user: { user_metadata?: Record<string, unknown> }, keys: string[]) {
  for (const key of keys) {
    const value = user.user_metadata?.[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = createWorkspaceInputSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace input is invalid.",
      },
      { status: 400 },
    );
  }

  const supabase = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(supabase);

  if (!user) {
    return NextResponse.json({ error: "Sign in before creating a workspace." }, { status: 401 });
  }

  await ensureProfileForUser(supabase, user);

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.rpc("create_workspace", {
    actor_avatar_url: getUserMetadataString(user, ["avatar_url", "picture"]),
    actor_email: user.email ?? undefined,
    actor_full_name: getUserMetadataString(user, ["full_name", "name"]),
    actor_user_id: user.id,
    requested_slug: normalizeWorkspaceSlug(parsed.data.slug),
    workspace_name: parsed.data.name.trim(),
  });

  if (error || !data) {
    return NextResponse.json(
      {
        error: "Wallie could not create that workspace right now.",
      },
      { status: 500 },
    );
  }

  return NextResponse.json(
    {
      redirectTo: workspaceOnboardingPath(data.slug),
      workspace: {
        id: data.id,
        name: data.name,
        slug: data.slug,
      },
    },
    { status: 201 },
  );
}
