import { z } from "zod";
import { browserCaptureReceiptSchema } from "@/lib/validation-evidence/browser-contract";

import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

/** These are recorded observations, not a readiness decision. */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const { session, supabase } = await loadReviewContext(sessionId);
    const [commands, browser] = await Promise.all([
      supabase
        .from("session_validation_evidence")
        .select(
          "run_id, workspace_id, session_id, job_id, attempt_count, repository_id, repository_full_name, commit_sha, validation_tree_sha, records, created_at",
        )
        .eq("session_id", session.id)
        .eq("workspace_id", session.workspace_id)
        .order("created_at", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(10),
      supabase
        .from("session_browser_verification_receipts")
        .select(
          "run_id, records, created_at, plan:session_validation_plans!inner(attempt_count, commit_sha, validation_tree_sha)",
        )
        .eq("session_id", session.id)
        .eq("workspace_id", session.workspace_id)
        .order("created_at", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(10),
    ]);
    const { data: evidence, error } = commands;
    if (error) throw error;
    if (browser.error) throw browser.error;
    const browserEvidence = (browser.data ?? []).flatMap(
      ({ records, plan, run_id, created_at }) => {
        const parsed = z.array(browserCaptureReceiptSchema).max(10).safeParse(records);
        if (!parsed.success || !plan) return [];
        return [
          {
            runId: run_id,
            attemptCount: plan.attempt_count,
            commitSha: plan.commit_sha,
            treeSha: plan.validation_tree_sha,
            createdAt: created_at,
            records: parsed.data.map((record) =>
              record.status === "captured" && record.kind === "screenshot"
                ? {
                    ...record,
                    downloadUrl: `/api/sessions/${session.id}/validation-evidence/browser-assets/${record.manifest.assetId}`,
                  }
                : record,
            ),
          },
        ];
      },
    );
    if (!evidence?.length) return reviewJson({ evidence: [], assets: [], browserEvidence });

    // Ten receipts with at most 100 manifests each fit within PostgREST's
    // default 1,000-row ceiling, preserving every selected receipt's assets.
    const { data: assets, error: assetError } = await supabase
      .from("session_validation_assets")
      .select("id, run_id, evidence_key, kind, required, sha256, content_type, size_bytes")
      .eq("session_id", session.id)
      .eq("workspace_id", session.workspace_id)
      .in(
        "run_id",
        evidence.map((item) => item.run_id),
      )
      .order("id", { ascending: true })
      .limit(1000);
    if (assetError) throw assetError;
    return reviewJson({
      evidence,
      browserEvidence,
      assets: (assets ?? []).map((asset) => ({
        ...asset,
        downloadUrl: `/api/sessions/${session.id}/validation-evidence/assets/${asset.id}`,
      })),
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
