import { z } from "zod";

export type PublicationOperation =
  | "claim_publication"
  | "load_publication"
  | "assert_claim"
  | "load_source"
  | "read_bundle"
  | "resolve_repository"
  | "restore_push"
  | "adopt_checkpoint"
  | "publication";

const knownFailures = new Map([
  ["Checkpoint publication claim is absent.", "claim_absent"],
  ["Checkpoint publication claim expired.", "claim_expired"],
  ["Checkpoint publication source identity changed.", "source_identity_changed"],
  ["Checkpoint publication ref is absent.", "ref_absent"],
  ["Checkpoint publication ref changed.", "ref_changed"],
  ["No-code output must reuse its input checkpoint.", "unexpected_ref"],
  ["Checkpoint adoption will retry.", "adoption_failed"],
  ["Checkpoint publication timed out.", "publication_timeout"],
  ["Could not claim checkpoint publication.", "claim_failed"],
  ["Could not load checkpoint publication.", "publication_load_failed"],
  ["Checkpoint publication ownership changed.", "ownership_changed"],
  ["Source checkpoint is unavailable.", "checkpoint_unavailable"],
  ["Source repository connection is unavailable.", "repository_unavailable"],
  ["Source installation is unavailable.", "installation_unavailable"],
  ["Source repository identity could not be verified.", "repository_verification_failed"],
  ["Source repository identity changed.", "repository_identity_changed"],
  ["Source utility sandbox is unavailable.", "sandbox_unavailable"],
  ["Source Git operation failed.", "git_operation_failed"],
  ["Git output exceeded its limit.", "git_output_limit"],
  ["Could not record helper recovery deadline.", "helper_recovery_record_failed"],
  ["Source delivery sandbox cleanup will retry.", "sandbox_cleanup_failed"],
  ["Could not prepare source delivery.", "workspace_prepare_failed"],
  ["Could not provision source delivery sandbox.", "sandbox_provision_failed"],
  ["Source checkpoint integrity verification failed.", "checkpoint_integrity_failed"],
  ["Source delivery requires a canonical GitHub repository URL.", "repository_url_invalid"],
  ["Exact checkpoint publication requires a retained checkpoint ref.", "retained_ref_invalid"],
  ["Invalid source bundle header.", "bundle_header_invalid"],
  ["Invalid remote source commit.", "remote_commit_invalid"],
  ["Checkpoint does not contain its recorded source commit.", "checkpoint_commit_missing"],
  ["Retained checkpoint ref has a different source commit.", "retained_ref_conflict"],
  ["Retained checkpoint ref could not be verified.", "retained_ref_unverified"],
  ["Recovery branch has unrelated source changes.", "recovery_ref_conflict"],
  ["Recovery branch could not receive the source checkpoint.", "recovery_push_failed"],
  ["Could not restore and push the source checkpoint.", "restore_push_failed"],
]);

const httpStatus = z.number().int().min(100).max(599);
const errorMetadata = z.object({
  message: z.string().optional().catch(undefined),
  status: httpStatus.optional().catch(undefined),
  statusCode: httpStatus.optional().catch(undefined),
  response: z.object({ status: httpStatus.optional() }).optional().catch(undefined),
  code: z
    .union([z.number().int().min(0).max(255), z.string()])
    .optional()
    .catch(undefined),
  cause: z.unknown().optional(),
});
const databaseCodes = new Set(["42501", "23503", "23505", "40001", "40P01", "PGRST116"]);
const unknownFailure = {
  errorCode: "operation_failed",
  message: "Checkpoint publication operation failed.",
};

/** Retain the original cause in memory; only the bounded diagnostic below may be logged. */
export class PublicationOperationError extends Error {
  constructor(
    readonly operation: PublicationOperation,
    cause: unknown,
  ) {
    super(publicationFailureDiagnostic(cause).message, { cause });
    this.name = "PublicationOperationError";
  }
}

export async function withPublicationOperation<T>(
  operation: PublicationOperation,
  execute: () => Promise<T>,
): Promise<T> {
  try {
    return await execute();
  } catch (error) {
    if (error instanceof PublicationOperationError) throw error;
    throw new PublicationOperationError(operation, error);
  }
}

/** External messages, stacks, response bodies, and arbitrary error codes are never diagnostic data. */
export function publicationFailureDiagnostic(error: unknown) {
  let failure = unknownFailure;
  let operation: PublicationOperation = "publication";
  let status: number | undefined;
  let exitCode: number | undefined;
  let databaseCode: string | undefined;
  let cause = error;
  for (let depth = 0; depth < 6 && cause; depth++) {
    if (cause instanceof PublicationOperationError) operation = cause.operation;
    const parsed = errorMetadata.safeParse(cause);
    if (!parsed.success) break;
    const metadata = parsed.data;
    const code = metadata.message && knownFailures.get(metadata.message);
    if (code && metadata.message) failure = { errorCode: code, message: metadata.message };
    status ??= metadata.status ?? metadata.statusCode ?? metadata.response?.status;
    if (typeof metadata.code === "number") exitCode ??= metadata.code;
    else if (metadata.code && databaseCodes.has(metadata.code)) databaseCode ??= metadata.code;
    cause = metadata.cause;
  }
  return {
    operation,
    ...failure,
    ...(status !== undefined ? { httpStatus: status } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(databaseCode ? { databaseCode } : {}),
  };
}
