import type { ReviewEvidenceDelivery } from "./review-evidence-contracts";

export type DeliveryBlocker = ReviewEvidenceDelivery["evaluation"]["blockers"][number];

const CHECK_CODE_PREFIXES = [
  "github_check_",
  "github_checks_",
  "github_required_check",
  "github_required_status",
  "github_actions_",
  "github_branch_protection",
  "github_rule_",
  "github_administration_",
];

const REVIEW_CODE_PREFIXES = [
  "github_review",
  "github_changes_requested",
  "github_approvals_required",
  "github_code_owner_",
  "github_threads",
];

const REFRESH_CODES = new Set([
  "github_refresh_missing",
  "github_refresh_pending",
  "github_refresh_in_progress",
  "github_refresh_failed",
  "github_observation_missing",
  "github_observation_time_unknown",
  "github_observation_future",
  "github_observation_expired",
]);

function requirementSuffix(requirement: string | undefined) {
  return requirement ? ` “${requirement}”` : "";
}

/** Deterministic human labels from fixed server codes. Provider text never enters. */
export function formatDeliveryBlocker(blocker: DeliveryBlocker): string {
  const requirement = requirementSuffix(blocker.requirement);
  switch (blocker.code) {
    case "github_observation_missing":
      return "GitHub has not observed this canonical pull request yet.";
    case "github_access_unavailable":
      return "GitHub access is unavailable.";
    case "github_repository_unavailable":
      return "The linked GitHub repository is unavailable.";
    case "github_repository_archived":
      return "The linked GitHub repository is archived.";
    case "github_installation_suspended":
      return "The GitHub App installation is suspended.";
    case "canonical_pr_missing":
      return "No canonical pull request is linked to this session.";
    case "pr_epoch_changed":
      return "The canonical pull request changed; verification belongs to an older revision.";
    case "pr_sync_missing":
      return "Wallie has not synchronized the accepted checkpoint to a pull request.";
    case "pr_sync_pending":
      return "Wallie is still synchronizing the accepted checkpoint to GitHub.";
    case "checkpoint_missing":
      return "No accepted code checkpoint is available.";
    case "checkpoint_changed":
      return "The accepted checkpoint changed after this observation.";
    case "pr_head_checkpoint_mismatch":
      return "The pull request head no longer matches the accepted checkpoint.";
    case "policy_revision_changed":
      return "The delivery policy changed; refresh verification.";
    case "review_revision_changed":
      return "Artifact review feedback changed; refresh verification.";
    case "github_refresh_missing":
      return "GitHub verification has not been scheduled for this session.";
    case "github_refresh_pending":
      return "GitHub verification refresh is queued.";
    case "github_refresh_in_progress":
      return "GitHub verification refresh is running.";
    case "github_refresh_failed":
      return "The last GitHub verification refresh failed. Retry refresh.";
    case "github_observation_time_unknown":
      return "The GitHub observation time is unknown.";
    case "github_observation_future":
      return "The GitHub observation time is in the future.";
    case "github_observation_expired":
      return "The GitHub observation is older than the configured freshness window.";
    case "github_checks_not_passed":
      return "Required GitHub checks have not passed on the current head.";
    case "github_checks_empty":
      return "GitHub returned no checks or statuses for the current head.";
    case "github_required_check_missing":
      return `Required check${requirement} is absent from the current head.`;
    case "github_required_check_pending":
      return `Required check${requirement} is still running.`;
    case "github_required_check_failed":
      return `Required check${requirement} failed on the current head.`;
    case "github_required_check_stale":
      return `Required check${requirement} is older than the verification window.`;
    case "github_required_check_source_unknown":
      return `Could not verify the GitHub App source for required check${requirement}.`;
    case "github_required_status_pending":
      return `Required status${requirement} is still pending.`;
    case "github_required_status_failed":
      return `Required status${requirement} failed on the current head.`;
    case "github_required_status_stale":
      return `Required status${requirement} is older than the verification window.`;
    case "github_required_status_source_unknown":
      return `Could not verify the GitHub App source for required status${requirement}.`;
    case "github_actions_provenance_unknown":
      return `GitHub Actions provenance for required check${requirement} is unknown.`;
    case "github_actions_event_ineligible":
      return `Required check${requirement} was not produced by an eligible workflow event.`;
    case "github_administration_permission_missing":
      return "GitHub Administration read permission is missing, so branch protection cannot be verified.";
    case "github_branch_protection_unavailable":
      return "GitHub branch protection could not be verified.";
    case "github_branch_protection_changed":
      return "GitHub branch protection changed during collection.";
    case "github_rule_unsupported":
      return `GitHub repository rule${requirement} is not supported by the verification collector.`;
    case "github_reviews_not_passed":
      return "GitHub review requirements have not passed on the current head.";
    case "github_changes_requested":
      return "A reviewer requested changes on GitHub.";
    case "github_approvals_required":
      return "Required GitHub approvals are missing on the current head.";
    case "github_review_decision_unknown":
      return "GitHub review decision is unknown.";
    case "github_code_owner_policy_unverified":
      return "The required code-owner policy could not be verified on GitHub.";
    case "github_code_owner_review_required":
      return "A code-owner approval is still required on GitHub.";
    case "github_threads_not_passed":
      return "GitHub review thread requirements have not passed.";
    case "github_review_threads_unresolved":
      return "Unresolved GitHub review threads remain.";
    case "artifact_blocking_feedback_open":
      return "Open blocking artifact feedback remains in Comments.";
    case "evidence_missing":
      return `Validation evidence${requirement} is missing for the accepted commit.`;
    case "evidence_stale":
      return `Validation evidence${requirement} belongs to a different commit or tree.`;
    case "evidence_failed":
      return `Validation evidence${requirement} did not pass for the accepted commit.`;
    case "evidence_unavailable":
      return `Validation evidence${requirement} is recorded but its required assets are unavailable.`;
    case "github_pr_draft":
      return "The pull request is still a draft.";
    case "github_mergeability_not_passed":
      return "GitHub has not reported a passing mergeable state.";
    case "github_mergeability_unknown":
      return "GitHub mergeability is unknown.";
    case "github_merge_conflict":
      return "The pull request has a merge conflict.";
    case "github_base_update_required":
      return "The pull request branch is behind its base and must be updated.";
    case "github_merge_state_unsupported":
      return "GitHub reported an unsupported merge state.";
    case "github_merge_blocked":
      return "GitHub reports the pull request as blocked from merging.";
    default:
      return `${blocker.code.replaceAll("_", " ")}${blocker.requirement ? `: ${blocker.requirement}` : ""}.`;
  }
}

export type DeliveryBlockerSource =
  | { kind: "external"; href: string; label: string }
  | { kind: "comments"; label: string }
  | { kind: "anchor"; href: string; label: string };

export type DeliveryBlockerSourceContext = {
  canRefresh: boolean;
  evidenceHref: string;
  prUrl: string | null;
  prChecksUrl: string | null;
  repositoryUrl: string | null;
};

/** Every blocker points at the place where a reviewer can inspect or recover it. */
export function deliveryBlockerSource(
  blocker: DeliveryBlocker,
  context: DeliveryBlockerSourceContext,
): DeliveryBlockerSource | null {
  if (
    blocker.code === "artifact_blocking_feedback_open" ||
    blocker.code === "review_revision_changed"
  )
    return { kind: "comments", label: "Open Comments" };
  if (blocker.code.startsWith("evidence_"))
    return { kind: "anchor", href: context.evidenceHref, label: "Review evidence" };
  if (REFRESH_CODES.has(blocker.code)) {
    if (context.canRefresh)
      return {
        kind: "anchor",
        href: "#review-evidence-refresh",
        label: "Refresh verification",
      };
    if (context.prUrl) return { kind: "external", href: context.prUrl, label: "Open pull request" };
    if (context.repositoryUrl)
      return { kind: "external", href: context.repositoryUrl, label: "Open repository" };
    return null;
  }
  if (CHECK_CODE_PREFIXES.some((prefix) => blocker.code.startsWith(prefix)))
    return context.prChecksUrl
      ? { kind: "external", href: context.prChecksUrl, label: "Open GitHub checks" }
      : context.prUrl
        ? { kind: "external", href: context.prUrl, label: "Open pull request" }
        : null;
  if (REVIEW_CODE_PREFIXES.some((prefix) => blocker.code.startsWith(prefix)))
    return context.prUrl
      ? {
          kind: "external",
          href: `${context.prUrl}#pullrequestreviews`,
          label: "Open GitHub reviews",
        }
      : null;
  if (context.prUrl) return { kind: "external", href: context.prUrl, label: "Open pull request" };
  if (context.repositoryUrl)
    return { kind: "external", href: context.repositoryUrl, label: "Open repository" };
  return null;
}

export function readinessStateLabel(state: ReviewEvidenceDelivery["evaluation"]["state"]): string {
  switch (state) {
    case "ready":
      return "Ready";
    case "blocked":
      return "Blocked";
    case "checking":
      return "Checking";
    case "merged":
      return "Merged on GitHub";
    case "closed":
      return "Closed on GitHub";
    default:
      return "Unknown";
  }
}

export function checkStatusLabel(
  status: ReviewEvidenceDelivery["checks"][number]["status"],
): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "pending":
      return "Pending";
    case "failed":
      return "Failed";
    case "missing":
      return "Missing";
    case "stale":
      return "Stale";
    default:
      return "Unknown";
  }
}

export type EvidenceRequirementStatus = NonNullable<
  ReviewEvidenceDelivery["evidence"]
>["required"][number]["status"];

export function evidenceStatusLabel(status: EvidenceRequirementStatus): string {
  switch (status) {
    case "passed":
      return "Passed";
    case "missing":
      return "Missing";
    case "stale":
      return "Stale";
    case "failed":
      return "Failed";
    default:
      return "Unavailable";
  }
}
