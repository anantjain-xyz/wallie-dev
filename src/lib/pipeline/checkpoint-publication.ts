import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  PublicationOperationError,
  publicationFailureDiagnostic,
  withPublicationOperation,
} from "./publication-diagnostics";
import { readSourceDeliveryBundle, resolveSourceDeliveryRepository } from "./source-delivery";
import { restoreAndPushSourceInSandbox } from "./source-delivery-sandbox";

type AdminClient = SupabaseClient<Database>;
export type CheckpointPublication = Tables<"session_checkpoint_publications">;

export class CheckpointPublicationPendingError extends Error {
  constructor() {
    super(
      "The code checkpoint is saved. Remote publication will retry within this attempt's original deadline.",
    );
    this.name = "CheckpointPublicationPendingError";
  }
}

/** Record the original output once, then drive the same durable intent as maintenance. */
export async function publishSessionCheckpoint(input: {
  admin: AdminClient;
  runId: string;
  jobId: string;
  attemptCount: number;
  workspaceId: string;
  expectedArtifactVersion: number;
  artifactMarkdown: string;
  deadlineAt?: string;
  signal?: AbortSignal;
}): Promise<"adopted" | "pending" | "stale"> {
  input.signal?.throwIfAborted();
  const request = input.admin.rpc("prepare_session_checkpoint_publication", {
    p_run_id: input.runId,
    p_expected_artifact_version: input.expectedArtifactVersion,
    p_artifact_md: input.artifactMarkdown,
    ...(input.deadlineAt ? { p_deadline_at: input.deadlineAt } : {}),
  });
  const { data: prepared, error } = await (input.signal
    ? request.abortSignal(input.signal)
    : request);
  input.signal?.throwIfAborted();
  // An unknown commit outcome is never permission to fail or replace this intent.
  if (error) throw new CheckpointPublicationPendingError();
  if (!prepared) return "stale";
  await drainCheckpointPublications(input.admin, {
    runId: input.runId,
    limit: 1,
    signal: input.signal,
  });
  input.signal?.throwIfAborted();
  const controller = new AbortController();
  const signal = input.signal
    ? AbortSignal.any([controller.signal, input.signal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    if (signal.aborted) reject(signal.reason);
    timer = setTimeout(
      () => controller.abort(new Error("Publication receipt read timed out.")),
      5_000,
    );
  });
  try {
    const { data, error: readError } = await Promise.race([
      input.admin
        .from("session_checkpoint_publications")
        .select("status")
        .eq("run_id", input.runId)
        .eq("workspace_id", input.workspaceId)
        .eq("job_id", input.jobId)
        .eq("attempt_count", input.attemptCount)
        .abortSignal(signal)
        .maybeSingle(),
      aborted,
    ]);
    if (readError) throw new CheckpointPublicationPendingError();
    return data?.status === "adopted"
      ? "adopted"
      : data?.status === "stale" || !data
        ? "stale"
        : "pending";
  } catch {
    throw new CheckpointPublicationPendingError();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function assertPublicationClaim(
  admin: AdminClient,
  publication: CheckpointPublication,
  signal: AbortSignal,
) {
  return withPublicationOperation("assert_claim", async () => {
    signal.throwIfAborted();
    if (!publication.claim_id) throw new Error("Checkpoint publication claim is absent.");
    const { data, error } = await admin
      .rpc("assert_session_checkpoint_publication_claim", {
        p_run_id: publication.run_id,
        p_claim_id: publication.claim_id,
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (error || data !== true)
      throw new Error("Checkpoint publication claim expired.", { cause: error });
  });
}

/** Push only an immutable candidate ref. PR synchronization remains a separate outbox. */
export async function adoptCheckpointPublication(
  admin: AdminClient,
  publication: CheckpointPublication,
  signal: AbortSignal,
): Promise<boolean> {
  await assertPublicationClaim(admin, publication, signal);
  const source = await withPublicationOperation("load_source", async () => {
    const { data, error } = await admin
      .from("session_source_deliveries")
      .select("*")
      .eq("run_id", publication.run_id)
      .eq("workspace_id", publication.workspace_id)
      .abortSignal(signal)
      .single();
    signal.throwIfAborted();
    if (
      error ||
      !data ||
      data.job_id !== publication.job_id ||
      data.session_id !== publication.session_id ||
      data.attempt_count !== publication.attempt_count
    ) {
      throw new Error("Checkpoint publication source identity changed.", { cause: error });
    }
    return data;
  });
  let remoteRef: string | undefined;
  let remoteSha: string | undefined;
  if (source.base_sha !== source.head_sha) {
    if (!publication.retained_ref?.startsWith("refs/heads/"))
      throw new PublicationOperationError(
        "load_source",
        new Error("Checkpoint publication ref is absent."),
      );
    const bytes = await withPublicationOperation("read_bundle", () =>
      readSourceDeliveryBundle(admin, source, signal),
    );
    const current = await withPublicationOperation("resolve_repository", () =>
      resolveSourceDeliveryRepository(admin, source, signal),
    );
    await assertPublicationClaim(admin, publication, signal);
    const retainedBranch = publication.retained_ref.slice("refs/heads/".length);
    const branch = await withPublicationOperation("restore_push", () =>
      restoreAndPushSourceInSandbox(
        {
          baseSha: source.base_sha,
          headSha: source.head_sha,
          branch: retainedBranch,
          exactRef: true,
          bytes,
          sha256: source.bundle_sha256 ?? "",
          remoteUrl: `https://github.com/${current.delivery.repository_full_name}.git`,
          token: current.token,
          signal,
          beforePush: () => assertPublicationClaim(admin, publication, signal),
        },
        { admin, workspaceId: source.workspace_id, runId: source.run_id },
      ),
    );
    remoteRef = `refs/heads/${branch}`;
    remoteSha = source.head_sha;
    if (remoteRef !== publication.retained_ref)
      throw new PublicationOperationError(
        "restore_push",
        new Error("Checkpoint publication ref changed."),
      );
  } else if (publication.retained_ref)
    throw new PublicationOperationError(
      "load_source",
      new Error("No-code output must reuse its input checkpoint."),
    );
  await assertPublicationClaim(admin, publication, signal);
  return withPublicationOperation("adopt_checkpoint", async () => {
    const { data: adopted, error: adoptionError } = await admin
      .rpc("adopt_session_checkpoint_publication", {
        p_run_id: publication.run_id,
        p_claim_id: publication.claim_id!,
        ...(remoteRef ? { p_remote_ref: remoteRef, p_remote_sha: remoteSha } : {}),
      })
      .abortSignal(signal);
    signal.throwIfAborted();
    if (adoptionError) throw new Error("Checkpoint adoption will retry.", { cause: adoptionError });
    return adopted === true;
  });
}

export async function drainCheckpointPublications(
  admin: AdminClient,
  options: {
    runId?: string;
    limit?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
  } = {},
) {
  const result = { adopted: 0, failed: 0 };
  for (let index = 0; index < (options.limit ?? 3); index++) {
    const controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([controller.signal, options.signal])
      : controller.signal;
    const timeout = setTimeout(
      () =>
        controller.abort(
          new PublicationOperationError(
            "publication",
            new Error("Checkpoint publication timed out."),
          ),
        ),
      options.timeoutMs ?? 60_000,
    );
    const aborted = new Promise<never>((_, reject) => {
      const abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    let publication: CheckpointPublication | null = null;
    try {
      const work = (async () => {
        signal.throwIfAborted();
        const claim = await withPublicationOperation("claim_publication", async () => {
          const { data, error } = await admin
            .rpc(
              "claim_session_checkpoint_publication",
              options.runId ? { p_run_id: options.runId } : {},
            )
            .abortSignal(signal);
          signal.throwIfAborted();
          if (error) throw new Error("Could not claim checkpoint publication.", { cause: error });
          return data;
        });
        if (!claim) return false;
        const data = await withPublicationOperation("load_publication", async () => {
          const { data, error } = await admin
            .from("session_checkpoint_publications")
            .select("*")
            .eq("claim_id", claim)
            .abortSignal(signal)
            .single();
          signal.throwIfAborted();
          if (error || !data || (options.runId && data.run_id !== options.runId))
            throw new Error("Could not load checkpoint publication.", { cause: error });
          return data;
        });
        publication = data;
        if (!(await adoptCheckpointPublication(admin, data, signal)))
          throw new PublicationOperationError(
            "adopt_checkpoint",
            new Error("Checkpoint publication ownership changed."),
          );
        return true;
      })();
      if (!(await Promise.race([work, aborted]))) break;
      result.adopted++;
    } catch (error) {
      result.failed++;
      const current = publication as CheckpointPublication | null;
      if (current?.claim_id && !signal.aborted) {
        await Promise.race([
          admin
            .rpc("release_session_checkpoint_publication", {
              p_run_id: current.run_id,
              p_claim_id: current.claim_id,
            })
            .abortSignal(signal)
            .then(
              () => undefined,
              () => undefined,
            ),
          aborted,
        ]).catch(() => undefined);
      }
      console.warn("[checkpoint-publication] retry scheduled", {
        runId: current?.run_id ?? options.runId ?? null,
        jobId: current?.job_id ?? null,
        attemptCount: current?.attempt_count ?? null,
        publicationAttemptCount: current?.publication_attempt_count ?? null,
        ...publicationFailureDiagnostic(error),
      });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return result;
}
