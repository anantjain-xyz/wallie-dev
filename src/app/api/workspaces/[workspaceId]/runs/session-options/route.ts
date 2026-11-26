import { NextResponse } from "next/server";
import { z } from "zod";

import { runCatalogParamsSchema } from "@/features/wallie/run-catalog-contracts";
import { loadRunSessionOptions } from "@/features/wallie/runs-list-options";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";

const searchSchema = z.object({
  factory: z.union([z.literal("all"), z.string().uuid()]),
  q: z.string().trim().max(120).optional(),
});
const headers = { "Cache-Control": "private, no-store" };

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> },
) {
  const owner = runCatalogParamsSchema.safeParse(await params);
  const search = searchSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!owner.success || !search.success) {
    return NextResponse.json({ error: "Invalid session search." }, { status: 400, headers });
  }
  try {
    const access = await requireWorkspaceAccessById(owner.data.workspaceId);
    if (!access.ok) {
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    }
    const options = await loadRunSessionOptions(
      {
        supabase: access.context.supabase,
        workspaceId: access.context.workspace.id,
        factoryId: search.data.factory === "all" ? undefined : search.data.factory,
      },
      { search: search.data.q ?? "" },
    );
    return NextResponse.json(options, { headers });
  } catch {
    return NextResponse.json({ error: "Could not load sessions." }, { status: 500, headers });
  }
}
