import Link from "next/link";

import { PlusIcon } from "@/components/shared/icons";
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
  workspaceSlug: string;
};

/**
 * First-run zero-state for surfaces that list sessions (the board and the
 * sessions list). Unlike a no-filter-match message, this tells a new user what
 * the page will hold and hands them the next action as a button: "Resume setup"
 * while onboarding is incomplete, otherwise "New session".
 */
export function SessionsZeroState({
  className,
  newSessionHref,
  onboarding,
  workspaceSlug,
}: SessionsZeroStateProps) {
  const shouldResumeSetup = shouldShowOnboardingResumeCta(onboarding);

  return (
    <div
      className={cn(
        "ui-sheet flex flex-col items-center border-dashed px-6 py-16 text-center",
        className,
      )}
    >
      <p className="text-[14px] font-semibold text-foreground">No sessions yet</p>
      <p className="mt-2 max-w-sm text-[13px] leading-5 text-muted">
        {shouldResumeSetup
          ? "Finish workspace setup before starting the first session."
          : "Turn a Linear issue into a session and Wallie drives it through your pipeline, one approval at a time."}
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
