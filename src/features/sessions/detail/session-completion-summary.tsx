import type { SessionReviewSession } from "@/features/sessions/detail/data";

/** Approval completes the pipeline; it does not prove that a PR merged or deployed. */
export function SessionCompletionSummary({
  session,
}: {
  session: Pick<SessionReviewSession, "phaseStatus" | "pullRequests">;
}) {
  if (session.phaseStatus !== "approved") return null;

  const linkedPullRequests = session.pullRequests.filter((pr) => pr.pullRequestUrl);

  return (
    <section aria-label="Session result" className="ui-sheet mb-5 p-4 sm:p-5">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-success-soft text-success"
        >
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path className="ui-completion-check" pathLength="1" d="m5 12 4 4L19 6" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-foreground" aria-live="polite">
            Session complete
          </h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            The final stage is approved. Explore the stage outputs and run history below.
          </p>
          {linkedPullRequests.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-2" aria-label="Related pull requests">
              {linkedPullRequests.map((pr, index) => (
                <a
                  key={pr.id}
                  className="ui-button gap-2"
                  href={pr.pullRequestUrl!}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open{" "}
                  {pr.pullRequestNumber
                    ? `PR #${pr.pullRequestNumber}`
                    : linkedPullRequests.length === 1
                      ? "pull request"
                      : `pull request ${index + 1}`}
                  <span aria-hidden="true">↗</span>
                  <span className="sr-only"> (opens in a new tab)</span>
                </a>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-muted">No pull request is linked to this session.</p>
          )}
        </div>
      </div>
    </section>
  );
}
