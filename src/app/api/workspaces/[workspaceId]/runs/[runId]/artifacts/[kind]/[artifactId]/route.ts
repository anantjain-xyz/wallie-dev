import { NextResponse } from "next/server";

import { findRunArtifact, readRunArtifact } from "@/features/wallie/run-artifacts";
import {
  runArtifactItemParamsSchema,
  runArtifactItemQuerySchema,
} from "@/features/wallie/run-artifacts-contracts";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export const preferredRegion = "home";
const headers = { "Cache-Control": "private, no-store" };
const downloadErrorStatus = {
  missing: 404,
  expired: 410,
  redacted: 410,
  inaccessible: 403,
  integrity_mismatch: 409,
  unavailable: 503,
};
type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string; kind: string; artifactId: string }>;
};

export async function GET(request: Request, { params }: RouteContext) {
  const target = runArtifactItemParamsSchema.safeParse(await params);
  const query = runArtifactItemQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!target.success || !query.success) {
    return NextResponse.json({ error: "Invalid run artifact request." }, { status: 400, headers });
  }
  try {
    const access = await requireWorkspaceAccessById(target.data.workspaceId);
    if (!access.ok)
      return NextResponse.json({ error: access.error }, { status: access.status, headers });
    const scope = {
      supabase: access.context.supabase,
      workspaceId: access.context.workspace.id,
      runId: target.data.runId,
    };
    const artifact = await findRunArtifact(scope, target.data);
    if (!artifact) {
      return NextResponse.json({ error: "Run artifact not found." }, { status: 404, headers });
    }

    if (!query.data.download && artifact.availability !== "recorded") {
      return NextResponse.json({ artifact }, { headers });
    }
    const content = await readRunArtifact(scope, artifact, request.signal);
    if (!query.data.download) {
      return NextResponse.json(
        {
          artifact: {
            ...artifact,
            availability: content.status,
            downloadable: content.status === "available",
          },
        },
        { headers },
      );
    }
    if (content.status !== "available") {
      return NextResponse.json(
        { error: "Run artifact is unavailable.", availability: content.status },
        { status: downloadErrorStatus[content.status], headers },
      );
    }

    const extension = artifact.kind === "stage_markdown" ? "md" : "txt";
    return new Response(content.bytes, {
      headers: {
        ...headers,
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": `attachment; filename="wallie-${artifact.id}.${extension}"`,
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return NextResponse.json({ error: "Could not load run artifact." }, { status: 500, headers });
  }
}
