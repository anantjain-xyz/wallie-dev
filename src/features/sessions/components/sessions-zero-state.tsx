import Link from "next/link";

import { PlusIcon } from "@/components/shared/icons/plus-icon";
import {
  shouldShowOnboardingResumeCta,
  type OnboardingResumeState,
} from "@/features/onboarding/resume";
import { workspaceOnboardingPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type SessionsZeroStateProps = {
  className?: string;
  newSessionHref: string;
  onboarding: OnboardingResumeState | null;
  variant?: "archived" | "first-run";
  workspaceSlug: string;
};

/**
 * Zero-state for surfaces that list sessions (the board and the sessions
 * list). The archived variant avoids presenting an experienced workspace as a
 * first-time user. The next action is "Resume setup" while onboarding is
 * incomplete, otherwise "New session".
 */
export function SessionsZeroState({
  className,
  newSessionHref,
  onboarding,
  variant = "first-run",
  workspaceSlug,
}: SessionsZeroStateProps) {
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);
  const hasArchivedSessions = variant === "archived";

  return (
    <div
      className={cn(
        "ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <p className="text-[14px] font-semibold text-foreground">
        {hasArchivedSessions ? "No active sessions" : "No sessions yet"}
      </p>
      <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
        {hasArchivedSessions
          ? shouldResumeSetup
            ? "All sessions have been archived. Finish workspace setup before starting another session."
            : "All sessions have been archived. Start a new session to move more work through your pipeline."
          : shouldResumeSetup
            ? "Finish workspace setup before starting the first session."
            : "Describe a task and Wallie drives it through your pipeline, one approval at a time. You can also attach a Linear issue."}
      </p>
      <div className="mt-5">
        {shouldResumeSetup ? (
          <Link className="ui-button-primary min-h-9" href={workspaceOnboardingPath(workspaceSlug)}>
            Resume setup
          </Link>
        ) : (
          <Link
            className="ui-button-primary inline-flex min-h-9 items-center gap-2"
            href={newSessionHref}
          >
            <PlusIcon className="h-3.5 w-3.5" />
            New session
          </Link>
        )}
      </div>
    </div>
  );
}
