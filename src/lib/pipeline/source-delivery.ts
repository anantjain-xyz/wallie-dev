import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { mintSandboxRepositoryToken } from "@/features/github/sandbox-token";
import type { Database, Tables } from "@/lib/supabase/database.types";
import { uploadWorkspaceObject } from "@/lib/workspaces/resource-operations";

import { SOURCE_CHECKPOINT_BUCKET, type SourceCheckpoint } from "./source-checkpoint";
import { restoreAndPushSource } from "./source-delivery-git";
import { ensureSourcePullRequest } from "./source-pull-request";

type AdminClient = SupabaseClient<Database>;
export type SourceDelivery = Tables<"session_source_deliveries">;

/** No raw source or transport error is safe to include in logs or run history. */
export class SourcePreservationError extends Error {
  constructor(durable = false, reason?: "lfs") {
    super(
      (reason === "lfs"
        ? "Changed Git LFS files require external payload storage and cannot be checkpointed. "
        : "Source checkpoint could not be recorded. ") +
        "No artifact was published. " +
        (durable
          ? "The durable checkpoint is retained for recovery."
          : "The sandbox is retained until its provider expiry for recovery."),
    );
    this.name = "SourcePreservationError";
  }
}

export async function prepareSourceDelivery(input: {
  admin: AdminClient;
  baseBranch: string;
  body: string;
  checkpoint: SourceCheckpoint;
  onDurable: () => void;
  repositoryId: string;
  runId: string;
  signal?: AbortSignal;
  title: string;
  workspaceId: string;
}): Promise<boolean> {
  const { checkpoint } = input;
  let checkpointPath = "";
  let fallback = "";
  input.signal?.throwIfAborted();
  if (checkpoint.kind === "bundle") {
    // The deterministic key also identifies an uploaded object if the worker
    // dies before creating its outbox row. Workspace deletion sweeps the prefix.
    const path = `${input.workspaceId}/${input.runId}.bundle`;
    try {
      const { error } = await uploadWorkspaceObject(input.admin, {
        bucket: SOURCE_CHECKPOINT_BUCKET,
        bytes: checkpoint.bytes,
        contentType: "application/octet-stream",
        path,
        workspaceId: input.workspaceId,
      });
      if (error) throw new Error("Upload failed.");
      checkpointPath = path;
      input.onDurable();
    } catch {
      // The bounded fallback is private DB data, never a log or diagnostic.
      fallback = checkpoint.bytes.toString("base64");
    }
  } else input.onDurable();
  input.signal?.throwIfAborted();
  const { data, error } = await input.admin.rpc("prepare_session_source_delivery", {
    p_run_id: input.runId,
    p_repository_id: input.repositoryId,
    p_base_branch: input.baseBranch,
    p_base_sha: checkpoint.baseSha,
    p_head_sha: checkpoint.headSha,
    p_title: input.title.slice(0, 256),
    p_body: input.body.slice(0, 60000),
    p_checkpoint_path: checkpointPath,
    p_bundle_sha256: checkpoint.kind === "bundle" ? checkpoint.sha256 : "",
    p_bundle_base64: fallback,
  });
  if (error)
    throw new SourcePreservationError(checkpoint.kind === "unchanged" || checkpointPath !== "");
  if (data === true) input.onDurable();
  input.signal?.throwIfAborted();
  return data === true;
}

async function assertClaim(admin: AdminClient, delivery: SourceDelivery, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!delivery.claim_id) throw new Error("Delivery claim is absent.");
  const { data, error } = await admin
    .rpc("assert_session_source_delivery_claim", {
      p_run_id: delivery.run_id,
      p_claim_id: delivery.claim_id,
    })
    .abortSignal(signal);
  signal.throwIfAborted();
  if (error || data !== true) throw new Error("Delivery claim expired.");
}

async function resolveDeliveryRepository(
  admin: AdminClient,
  delivery: SourceDelivery,
  signal: AbortSignal,
) {
  if (!delivery.repository_id) throw new Error("Source repository connection is unavailable.");
  const { data: repository, error: repositoryError } = await admin
    .from("github_repositories")
    .select("full_name, github_installation_id, repo_id, is_archived")
    .eq("id", delivery.repository_id)
    .eq("workspace_id", delivery.workspace_id)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (
    repositoryError ||
    !repository ||
    repository.is_archived ||
    !Number.isSafeInteger(repository.repo_id) ||
    repository.repo_id <= 0 ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository.full_name)
  )
    throw new Error("Source repository connection is unavailable.");
  const { data: installation, error: installationError } = await admin
    .from("github_installations")
    .select("installation_id")
    .eq("id", repository.github_installation_id)
    .eq("workspace_id", delivery.workspace_id)
    .eq("suspended", false)
    .abortSignal(signal)
    .maybeSingle();
  signal.throwIfAborted();
  if (installationError || !installation) throw new Error("Source installation is unavailable.");
  const token = await mintSandboxRepositoryToken({
    installationId: installation.installation_id,
    repositoryFullName: repository.full_name,
    repositoryId: repository.repo_id,
    purpose: "execution",
  });
  signal.throwIfAborted();
  const response = await fetch(`https://api.github.com/repos/${repository.full_name}`, {
    signal,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!response.ok) throw new Error("Source repository identity could not be verified.");
  const current = (await response.json()) as { id?: number; full_name?: string };
  signal.throwIfAborted();
  if (
    current.id !== repository.repo_id ||
    current.full_name?.toLowerCase() !== repository.full_name.toLowerCase()
  )
    throw new Error("Source repository identity changed.");
  return {
    token,
    delivery: {
      ...delivery,
      installation_id: installation.installation_id,
      repository_full_name: repository.full_name,
    },
  };
}

export async function deliverSourceCheckpoint(
  admin: AdminClient,
  delivery: SourceDelivery,
  signal: AbortSignal,
) {
  await assertClaim(admin, delivery, signal);
  if (delivery.base_sha === delivery.head_sha) return;
  if (!delivery.repository_id) throw new Error("Source repository connection is unavailable.");
  let bytes: Buffer;
  if (delivery.bundle_base64) bytes = Buffer.from(delivery.bundle_base64, "base64");
  else {
    if (!delivery.checkpoint_path) throw new Error("Source checkpoint is unavailable.");
    const { data, error } = await admin.storage
      .from(SOURCE_CHECKPOINT_BUCKET)
      .download(delivery.checkpoint_path);
    signal.throwIfAborted();
    if (error || !data) throw new Error("Source checkpoint is unavailable.");
    bytes = Buffer.from(await data.arrayBuffer());
  }
  const current = await resolveDeliveryRepository(admin, delivery, signal);
  const { token } = current;
  await assertClaim(admin, delivery, signal);
  await restoreAndPushSource({
    baseSha: delivery.base_sha,
    headSha: delivery.head_sha,
    branch: delivery.branch_name,
    bytes,
    sha256: delivery.bundle_sha256 ?? "",
    remoteUrl: `https://github.com/${current.delivery.repository_full_name}.git`,
    token,
    signal,
    beforePush: () => assertClaim(admin, delivery, signal),
  });
  await assertClaim(admin, delivery, signal);
  await ensureSourcePullRequest({
    admin,
    delivery: current.delivery,
    token,
    signal,
    verifyOwnership: () => assertClaim(admin, delivery, signal),
  });
}

/** A lease survives worker crashes; bounded work releases the maintenance loop. */
export async function drainSourceDeliveries(
  admin: AdminClient,
  options: { limit?: number; timeoutMs?: number } = {},
) {
  const result = { delivered: 0, failed: 0 };
  for (let index = 0; index < (options.limit ?? 3); index++) {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error("Source delivery timed out.")),
      options.timeoutMs ?? 60_000,
    );
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
        once: true,
      }),
    );
    let delivery: SourceDelivery | null = null;
    try {
      const work = (async () => {
        const { data: claimId, error: claimError } = await admin
          .rpc("claim_session_source_delivery")
          .abortSignal(controller.signal);
        controller.signal.throwIfAborted();
        if (claimError) throw new Error("Could not claim source delivery.");
        if (!claimId) return false;
        const { data, error } = await admin
          .from("session_source_deliveries")
          .select("*")
          .eq("claim_id", claimId)
          .abortSignal(controller.signal)
          .single();
        controller.signal.throwIfAborted();
        if (error || !data) throw new Error("Could not load source delivery.");
        delivery = data;
        await deliverSourceCheckpoint(admin, data, controller.signal);
        controller.signal.throwIfAborted();
        const { data: finished, error: finishError } = await admin
          .rpc("finish_session_source_delivery", {
            p_run_id: data.run_id,
            p_claim_id: data.claim_id!,
            p_delivered: true,
          })
          .abortSignal(controller.signal);
        if (finishError || !finished) throw new Error("Source delivery claim expired.");
        return true;
      })();
      if (!(await Promise.race([work, aborted]))) break;
      result.delivered++;
    } catch {
      result.failed++;
      // A timeout leaves the claim to expire; a late worker cannot finish it.
      const current = delivery as SourceDelivery | null;
      if (current?.claim_id && !controller.signal.aborted) {
        await Promise.race([
          admin
            .rpc("finish_session_source_delivery", {
              p_run_id: current.run_id,
              p_claim_id: current.claim_id,
              p_delivered: false,
            })
            .abortSignal(controller.signal)
            .then(
              () => undefined,
              () => undefined,
            ),
          aborted,
        ]).catch(() => undefined);
      }
      console.warn("[source-delivery] retry scheduled", { runId: current?.run_id ?? null });
    } finally {
      clearTimeout(timeout);
      controller.abort();
    }
  }
  return result;
}
