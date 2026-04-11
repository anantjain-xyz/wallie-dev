import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { verifyLinearApiKey } from "@/lib/linear/client";
import { decryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const querySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export async function POST(request: NextRequest) {
  const parsed = querySchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get("workspaceId"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      {
        error: parsed.error.issues[0]?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data: row, error } = await admin
    .from("workspace_secrets")
    .select("encrypted_value")
    .eq("workspace_id", access.context.workspace.id)
    .eq("key", "LINEAR_API_KEY")
    .maybeSingle();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!row) {
    return NextResponse.json(
      { error: "Set LINEAR_API_KEY in workspace secrets first." },
      { status: 404 },
    );
  }

  const apiKey = decryptSecretValue(row.encrypted_value);
  const result = await verifyLinearApiKey(apiKey);

  if (!result.ok) {
    return NextResponse.json({ error: result.error ?? "Linear API key invalid." }, { status: 400 });
  }

  return NextResponse.json({ ok: true });
}
