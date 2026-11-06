import {
  loadReviewContext,
  reviewErrorResponse,
  reviewJson,
  reviewSessionParamsSchema,
} from "@/features/sessions/review/http";
import { loadPrDiff, PrDiffApiError } from "@/features/github/pr-diff";
import {
  mintPrVerificationToken,
  PrVerificationAuthError,
} from "@/features/github/pr-verification-auth";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const preferredRegion = "home";
type RouteContext = { params: Promise<{ sessionId: string }> };

function unavailable(error: unknown) {
  const code =
    error instanceof PrDiffApiError || error instanceof PrVerificationAuthError
      ? error.code
      : "github_unavailable";
  const status =
    error instanceof PrDiffApiError
      ? error.code === "github_not_found"
        ? 404
        : error.code === "github_access_denied"
          ? 403
          : error.code === "github_rate_limited"
            ? 429
            : 502
      : error instanceof PrVerificationAuthError && error.code === "github_permission_missing"
        ? 403
        : error instanceof PrVerificationAuthError && error.code === "github_rate_limited"
          ? 429
          : 503;
  return reviewJson(
    { error: "The canonical pull request diff is unavailable from GitHub.", code },
    status,
  );
}

/** Read-only bounded diff for the session's pinned canonical pull request. */
export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { sessionId } = reviewSessionParamsSchema.parse(await params);
    const { session } = await loadReviewContext(sessionId);
    const admin = createSupabaseAdminClient();
    const { data: sync, error: syncError } = await admin
      .from("session_pr_sync")
      .select("current_epoch_id")
      .eq("session_id", session.id)
      .maybeSingle();
    if (syncError) throw syncError;
    if (!sync?.current_epoch_id)
      return reviewJson({ error: "No canonical pull request is available." }, 409);

    const { data: epoch, error: epochError } = await admin
      .from("session_pr_epochs")
      .select("repository_id, repository_full_name, pr_number, pr_url")
      .eq("id", sync.current_epoch_id)
      .maybeSingle();
    if (epochError) throw epochError;
    if (!epoch?.repository_id || !epoch.pr_number)
      return reviewJson({ error: "No canonical pull request is available." }, 409);

    const { data: repository, error: repositoryError } = await admin
      .from("github_repositories")
      .select("id, full_name, repo_id, is_archived, github_installation_id, workspace_id")
      .eq("id", epoch.repository_id)
      .maybeSingle();
    if (repositoryError) throw repositoryError;
    if (
      !repository ||
      repository.workspace_id !== session.workspace_id ||
      repository.full_name.toLowerCase() !== epoch.repository_full_name.toLowerCase() ||
      repository.is_archived
    )
      return reviewJson({ error: "GitHub repository access is unavailable." }, 409);

    const { data: installation, error: installationError } = await admin
      .from("github_installations")
      .select("id, installation_id, suspended, workspace_id")
      .eq("id", repository.github_installation_id)
      .maybeSingle();
    if (installationError) throw installationError;
    if (
      !installation ||
      installation.workspace_id !== session.workspace_id ||
      installation.suspended
    )
      return reviewJson({ error: "GitHub installation access is unavailable." }, 409);

    let expectedUrl: string | null = null;
    try {
      const url = new URL(epoch.pr_url ?? "");
      if (url.protocol === "https:") expectedUrl = url.toString();
    } catch {
      // Legacy or absent URLs are still pinned by repository and PR number.
    }

    const signal = AbortSignal.timeout(20_000);
    const credential = await mintPrVerificationToken({
      installationId: installation.installation_id,
      repositoryNumericId: repository.repo_id,
      signal,
    });
    const diff = await loadPrDiff({
      ...credential,
      repositoryFullName: repository.full_name,
      repositoryNumericId: repository.repo_id,
      prNumber: epoch.pr_number,
      expectedUrl,
      signal,
    });
    return reviewJson({ diff });
  } catch (error) {
    if (error instanceof PrDiffApiError || error instanceof PrVerificationAuthError)
      return unavailable(error);
    return reviewErrorResponse(error);
  }
}
