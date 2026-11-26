import { NextResponse } from "next/server";

import { getEnabledSandboxProviders } from "@/lib/sandbox-connections/server";
import { lookupVercelTargets, vercelTargetLookupInput } from "@/lib/vercel-sandbox/target-catalog";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

type RouteContext = { params: Promise<{ workspaceId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  const headers = { "Cache-Control": "no-store" };
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { headers, status: access.status });
  }
  if (!getEnabledSandboxProviders().includes("vercel")) {
    return NextResponse.json({ error: "Vercel Sandbox is disabled." }, { headers, status: 404 });
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return NextResponse.json({ error: "Expected JSON." }, { headers, status: 415 });
  }
  const parsed = vercelTargetLookupInput.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Enter a valid Vercel token and team selection." },
      { headers, status: 400 },
    );
  }
  const result = await lookupVercelTargets({ input: parsed.data, signal: request.signal });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { headers, status: result.status });
  }
  return NextResponse.json(
    "teams" in result ? { teams: result.teams } : { projects: result.projects },
    { headers },
  );
}
