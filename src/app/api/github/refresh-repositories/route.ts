import { NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import { refreshGitHubRepositoriesSchema } from "@/features/github/contracts";
import { syncGitHubRepositoriesForWorkspace } from "@/features/github/service";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = refreshGitHubRepositoriesSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingAppKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "GitHub repository sync is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const admin = createSupabaseAdminClient();
  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("installation_id, workspace_id")
    .eq("workspace_id", access.context.workspace.id)
    .maybeSingle();

  if (installationError) {
    throw installationError;
  }

  if (!installation) {
    return NextResponse.json(
      {
        error: "Install the GitHub App for this workspace before refreshing repositories.",
      },
      { status: 404 },
    );
  }

  const result = await syncGitHubRepositoriesForWorkspace({
    installationId: installation.installation_id,
    workspaceId: installation.workspace_id,
  });

  return NextResponse.json(result, { status: 200 });
}
