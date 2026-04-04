import { NextResponse } from "next/server";

import { ensureProfileForUser } from "@/lib/auth";
import { workspaceIssuesPath } from "@/lib/routes";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createWorkspaceInputSchema, normalizeWorkspaceSlug } from "@/lib/workspaces";

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

  const { data, error } = await supabase.rpc("create_workspace", {
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
      redirectTo: workspaceIssuesPath(data.slug),
      workspace: {
        id: data.id,
        name: data.name,
        slug: data.slug,
      },
    },
    { status: 201 },
  );
}
