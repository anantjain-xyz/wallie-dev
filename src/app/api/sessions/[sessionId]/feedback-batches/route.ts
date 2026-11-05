import { z } from "zod";
import {
  loadReviewArtifact,
  loadReviewContext,
  readReviewPage,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { submittedCommentsSchema } from "@/features/sessions/review/feedback-history";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };
const runFields =
  "id, status, model_provider, model_name, attempt_count, created_at, finished_at" as const;

export async function GET(request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const query = new URL(request.url).searchParams;
    const artifactId = z.string().uuid().parse(query.get("artifactId"));
    const batchId = z
      .string()
      .uuid()
      .optional()
      .parse(query.get("batchId") ?? undefined);
    const page = readReviewPage(request);
    const context = await loadReviewContext(sessionId);
    const artifact = await loadReviewArtifact(context, artifactId);
    const { supabase, session } = context;
    const scoped = () =>
      supabase
        .from("artifact_feedback_batches")
        .select("*")
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .eq("stage_id", artifact.stage_id!);
    const run = async (id: string) => {
      const result = await supabase
        .from("agent_runs")
        .select(runFields)
        .eq("id", id)
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .maybeSingle();
      if (result.error) throw result.error;
      return result.data;
    };
    if (!artifact.stage_id) return reviewJson({ error: "Artifact stage is unavailable." }, 409);
    if (batchId) {
      const { data: batch, error } = await scoped().eq("id", batchId).maybeSingle();
      if (error) throw error;
      if (!batch) return reviewJson({ error: "Feedback batch not found." }, 404);
      let outputsQuery = supabase
        .from("artifact_feedback_outputs")
        .select("artifact_id, artifact_version, run_id, created_at")
        .eq("batch_id", batch.id)
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .order("created_at", { ascending: false })
        .order("run_id", { ascending: false })
        .limit(page.pageSize + 1);
      if (page.cursor)
        outputsQuery = outputsQuery.or(
          `created_at.lt.${page.cursor.createdAt},and(created_at.eq.${page.cursor.createdAt},run_id.lt.${page.cursor.id})`,
        );
      const [snapshots, outputsResult, initialRun] = await Promise.all([
        supabase
          .from("artifact_feedback_batch_threads")
          .select("*")
          .eq("batch_id", batch.id)
          .eq("workspace_id", session.workspace_id)
          .eq("session_id", session.id)
          .order("thread_id")
          .limit(21),
        outputsQuery,
        run(batch.run_id),
      ]);
      for (const result of [snapshots, outputsResult]) if (result.error) throw result.error;
      if ((snapshots.data?.length ?? 0) > 20)
        throw new Error("Feedback snapshot exceeds its contract.");
      const ids = [
        ...new Set([batch.artifact_id, ...(snapshots.data ?? []).map((row) => row.artifact_id)]),
      ];
      const sources = await supabase
        .from("session_artifacts")
        .select("id, version, stage_slug")
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .eq("stage_id", artifact.stage_id)
        .in("id", ids);
      if (sources.error) throw sources.error;
      const byId = new Map(sources.data?.map((row) => [row.id, row]));
      const outputs = (outputsResult.data ?? []).slice(0, page.pageSize).map((row) => {
        if (
          !row.artifact_id ||
          !row.run_id ||
          typeof row.artifact_version !== "number" ||
          !row.created_at
        )
          throw new Error("Accepted feedback output identity is unavailable.");
        return {
          artifactId: row.artifact_id,
          version: row.artifact_version,
          runId: row.run_id,
          createdAt: row.created_at,
        };
      });
      const outputRuns = outputs.length
        ? await supabase
            .from("agent_runs")
            .select(runFields)
            .eq("workspace_id", session.workspace_id)
            .eq("session_id", session.id)
            .in(
              "id",
              outputs.map((row) => row.runId),
            )
        : { data: [], error: null };
      if (outputRuns.error) throw outputRuns.error;
      const outputRunById = new Map(outputRuns.data?.map((row) => [row.id, row]));
      const lastOutput = outputs.at(-1);
      return reviewJson({
        batch,
        threads: (snapshots.data ?? []).map((row) => {
          const source = byId.get(row.artifact_id);
          if (!source) throw new Error("Feedback source is unavailable.");
          return {
            ...row,
            sourceVersion: source.version,
            sourceStageSlug: source.stage_slug,
            comments: (() => {
              const result = submittedCommentsSchema.safeParse(row.comments);
              if (!result.success) throw new Error("Stored feedback snapshot is invalid.");
              return result.data;
            })(),
          };
        }),
        initialRun,
        outputs: outputs.map((row) => ({ ...row, run: outputRunById.get(row.runId) ?? null })),
        outputNextCursor:
          outputsResult.data && outputsResult.data.length > page.pageSize && lastOutput
            ? { createdAt: lastOutput.createdAt, id: lastOutput.runId }
            : null,
      });
    }
    let batchesQuery = scoped()
      .select("id, artifact_id, artifact_version, actor_label, created_at, job_id, run_id")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(page.pageSize + 1);
    if (page.cursor)
      batchesQuery = batchesQuery.or(
        `created_at.lt.${page.cursor.createdAt},and(created_at.eq.${page.cursor.createdAt},id.lt.${page.cursor.id})`,
      );
    const [batches, checkpoint] = await Promise.all([
      batchesQuery,
      supabase
        .from("session_git_checkpoints")
        .select("run_id, job_id")
        .eq("artifact_id", artifact.id)
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .maybeSingle(),
    ]);
    if (batches.error) throw batches.error;
    if (checkpoint.error) throw checkpoint.error;
    let receivedBatchId: string | null = null;
    if (checkpoint.data) {
      const input = await supabase
        .from("artifact_feedback_batch_jobs")
        .select("batch_id")
        .eq("job_id", checkpoint.data.job_id)
        .eq("workspace_id", session.workspace_id)
        .eq("session_id", session.id)
        .maybeSingle();
      if (input.error) throw input.error;
      if (input.data) {
        const received = await scoped().select("id").eq("id", input.data.batch_id).maybeSingle();
        if (received.error) throw received.error;
        receivedBatchId = received.data?.id ?? null;
      }
    }
    const items = (batches.data ?? []).slice(0, page.pageSize);
    const last = items.at(-1);
    return reviewJson({
      batches: items,
      nextCursor:
        batches.data && batches.data.length > page.pageSize && last
          ? { createdAt: last.created_at, id: last.id }
          : null,
      producingRun: checkpoint.data ? await run(checkpoint.data.run_id) : null,
      receivedBatchId,
    });
  } catch (error) {
    return reviewErrorResponse(error);
  }
}
