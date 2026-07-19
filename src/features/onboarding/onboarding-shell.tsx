"use client";

import { useState } from "react";

import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import { Status } from "@/components/ui/status";
import type {
  getOnboardingStepRailItems,
  OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import {
  getOnboardingProgressSummary,
  onboardingStepStatusPresentation,
} from "@/features/onboarding/progress";
import type { WorkspaceOnboardingState, WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";
import { cn } from "@/lib/utils";

type RailItems = ReturnType<typeof getOnboardingStepRailItems>;

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  blocked: "text-danger/80 opacity-80",
  completed: "text-success hover:bg-success-soft/60 hover:text-success",
  current: "bg-accent-soft text-accent",
  error: "bg-danger-soft text-danger",
  skipped: "text-warning hover:bg-warning-soft/70 hover:text-warning",
  upcoming: "text-muted hover:bg-control-hover hover:text-foreground",
};

function OnboardingStepStatus({ state }: { state: OnboardingStepDisplayState }) {
  const presentation = onboardingStepStatusPresentation(state);
  return (
    <Status
      compact
      description={presentation.description}
      label={presentation.label}
      value={presentation.statusValue}
    />
  );
}

export function OnboardingProgressHeader({
  className,
  onboarding,
}: {
  className?: string;
  onboarding: WorkspaceOnboardingState;
}) {
  const progress = getOnboardingProgressSummary(onboarding);

  return (
    <div
      className={cn("min-w-0 space-y-2", className)}
      data-onboarding-progress
      data-percent={progress.percentComplete}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <p className="text-[13px] font-semibold tracking-tight text-foreground">
          <span data-onboarding-position>{progress.positionLabel}</span>
          <span className="mx-1.5 text-muted" aria-hidden="true">
            ·
          </span>
          <span data-onboarding-step-name>{progress.currentStepName}</span>
        </p>
        <p className="text-xs font-medium text-muted" data-onboarding-percent>
          {progress.percentComplete}% complete
        </p>
      </div>
      <div
        aria-label={`Setup progress ${progress.percentComplete} percent`}
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={progress.percentComplete}
        className="h-1.5 overflow-hidden rounded-full bg-control-muted"
        role="progressbar"
      >
        <div
          className="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
          style={{ width: `${progress.percentComplete}%` }}
        />
      </div>
      <p className="text-xs text-muted" data-onboarding-remaining>
        {progress.remainingRequiredLabel}
      </p>
    </div>
  );
}

function StepList({
  canSelect,
  currentStep,
  items,
  onSelect,
  variant,
}: {
  canSelect: boolean;
  currentStep: WorkspaceOnboardingStep;
  items: RailItems;
  onSelect: (step: WorkspaceOnboardingStep) => void;
  variant: "desktop" | "dialog";
}) {
  return (
    <ol className={cn("space-y-1", variant === "dialog" && "pb-1")}>
      {items.map((step) => {
        const presentation = onboardingStepStatusPresentation(step.displayState);
        const isCurrent = step.id === currentStep;
        return (
          <li key={step.id}>
            <button
              type="button"
              aria-current={isCurrent ? "step" : undefined}
              className={cn(
                "flex w-full items-center gap-2 rounded-[6px] px-3 py-1.5 text-left text-[13px] font-medium transition-colors",
                railStateClasses[step.displayState],
                (!canSelect || !step.isNavigable) && "cursor-not-allowed",
              )}
              data-step-state={step.displayState}
              disabled={!canSelect || !step.isNavigable}
              onClick={() => onSelect(step.id)}
            >
              <OnboardingStepStatus state={step.displayState} />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{step.title}</span>
                <span className="type-annotation mt-0.5 block truncate font-normal opacity-80">
                  {isCurrent && step.displayState === "error"
                    ? "Current · Error"
                    : presentation.label}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function OnboardingStepRail({
  canSelect,
  currentStep,
  items,
  onSelect,
}: {
  canSelect: boolean;
  currentStep: WorkspaceOnboardingStep;
  items: RailItems;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <StepList
      canSelect={canSelect}
      currentStep={currentStep}
      items={items}
      onSelect={onSelect}
      variant="desktop"
    />
  );
}

export function OnboardingMobileStepNav({
  canSelect,
  items,
  onboarding,
  onSelect,
}: {
  canSelect: boolean;
  items: RailItems;
  onboarding: WorkspaceOnboardingState;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = items.find((step) => step.id === onboarding.currentStep) ?? items[0];

  return (
    <div className="border-y border-border bg-sheet px-4 py-3 lg:hidden">
      <OnboardingProgressHeader onboarding={onboarding} />
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <button
            type="button"
            className="ui-button mt-3 w-full justify-between"
            data-onboarding-step-list-trigger
          >
            <span className="truncate text-left">
              {current ? `${current.shortTitle} · view all steps` : "View all steps"}
            </span>
          </button>
        </DialogTrigger>
        <DialogContent
          description="Jump to any setup step. Skipped steps stay incomplete and revisitable during setup."
          title="Setup steps"
        >
          <StepList
            canSelect={canSelect}
            currentStep={onboarding.currentStep}
            items={items}
            onSelect={(step) => {
              setOpen(false);
              onSelect(step);
            }}
            variant="dialog"
          />
          <div className="mt-4 flex justify-end">
            <DialogClose asChild>
              <button type="button" className="ui-button">
                Close
              </button>
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function focusOnboardingTarget(targetId: string | null) {
  if (!targetId || typeof document === "undefined") return;
  const target = document.getElementById(targetId);
  if (!target) return;
  if (typeof target.focus === "function") {
    target.focus();
  }
  target.scrollIntoView({ behavior: "smooth", block: "center" });
}
