"use client";

import dynamic from "next/dynamic";
import { Component, useEffect, type ErrorInfo, type ReactNode } from "react";

import type { getOnboardingStepRailItems } from "@/features/onboarding/flow";
import type { WorkspaceOnboardingStep } from "@/lib/onboarding/contracts";

import type { OnboardingStepProps } from "./types";

const stepLoaders = {
  github: () => import("./github-step"),
  repository: () => import("./repository-step"),
  pipeline: () => import("./pipeline-step"),
  linear: () => import("./linear-step"),
  runtime: () => import("./runtime-step"),
  verify: () => import("./verify-step"),
} satisfies Record<
  WorkspaceOnboardingStep,
  () => Promise<{ default: React.ComponentType<OnboardingStepProps> }>
>;

export function StepLoading() {
  return (
    <div
      aria-busy="true"
      aria-label="Loading setup step"
      className="min-h-[420px] animate-pulse rounded-[6px] border border-border bg-sheet p-5"
      role="status"
    >
      <div className="h-4 w-40 rounded bg-control-hover" />
      <div className="mt-3 h-3 w-3/4 rounded bg-control-hover" />
      <div className="mt-8 h-36 rounded bg-control-hover" />
    </div>
  );
}

const deferredSteps = {
  github: dynamic(stepLoaders.github, { loading: StepLoading }),
  repository: dynamic(stepLoaders.repository, { loading: StepLoading }),
  pipeline: dynamic(stepLoaders.pipeline, { loading: StepLoading }),
  linear: dynamic(stepLoaders.linear, { loading: StepLoading }),
  runtime: dynamic(stepLoaders.runtime, { loading: StepLoading }),
  verify: dynamic(stepLoaders.verify, { loading: StepLoading }),
} satisfies Record<WorkspaceOnboardingStep, React.ComponentType<OnboardingStepProps>>;

export class StepErrorBoundary extends Component<
  { children: ReactNode; step: WorkspaceOnboardingStep },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Deferred onboarding step failed", { error, info, step: this.props.step });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        className="min-h-[420px] rounded-[6px] border border-danger/20 bg-danger-soft p-5"
        role="alert"
      >
        <h3 className="text-[14px] font-semibold text-danger">This setup step could not load.</h3>
        <p className="mt-2 text-[13px] leading-5 text-danger">
          {this.state.error.message || "Reload the step and try again."}
        </p>
        <button
          className="ui-button mt-4"
          onClick={() => this.setState({ error: null })}
          type="button"
        >
          Retry
        </button>
      </div>
    );
  }
}

type RailItems = ReturnType<typeof getOnboardingStepRailItems>;

export function nextPreloadableStep(
  step: WorkspaceOnboardingStep,
  items: RailItems,
): WorkspaceOnboardingStep | null {
  const activeIndex = items.findIndex((item) => item.id === step);
  return (
    items
      .slice(activeIndex + 1)
      .find((item) => item.displayState !== "blocked" && item.displayState !== "skipped")?.id ??
    null
  );
}

export function ActiveOnboardingStep({
  items,
  step,
  ...props
}: OnboardingStepProps & { items: RailItems; step: WorkspaceOnboardingStep }) {
  const ActiveStep = deferredSteps[step];

  useEffect(() => {
    const nextStep = nextPreloadableStep(step, items);
    if (!nextStep) return;
    void stepLoaders[nextStep]();
  }, [items, step]);

  return (
    <StepErrorBoundary key={step} step={step}>
      <ActiveStep {...props} />
    </StepErrorBoundary>
  );
}
