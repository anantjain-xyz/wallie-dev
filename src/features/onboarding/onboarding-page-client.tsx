"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";

import { GitHubConnectionPanel } from "@/features/github/github-connection-panel";
import type { WorkspaceGitHubData, WorkspaceGitHubRepository } from "@/features/github/data";
import type { WorkspaceOnboardingData } from "@/features/onboarding/data";
import {
  buildOnboardingContinuePatch,
  buildOnboardingExitPatch,
  buildOnboardingRailNavigationPatch,
  buildOnboardingSkipPatch,
  canSkipOnboardingStep,
  getOnboardingStepRailItems,
  onboardingStepIndex,
  ONBOARDING_STEPS,
  type OnboardingStepDisplayState,
} from "@/features/onboarding/flow";
import type {
  OnboardingSetupHealth,
  WorkspaceOnboardingStep,
  WorkspaceOnboardingUpdatePayload,
} from "@/lib/onboarding/contracts";
import type { RepositoryProfileState } from "@/lib/repo-inference/contracts";
import { workspaceBasePath, workspaceSettingsPath } from "@/lib/routes";
import { cn } from "@/lib/utils";

type OnboardingPageClientProps = {
  initialData: WorkspaceOnboardingData;
};

type HealthTone = "accent" | "danger" | "neutral" | "success" | "warning";

type HealthSummaryItem = {
  detail: string;
  label: string;
  tone: HealthTone;
  value: string;
};

type StepHealthItem = {
  label: string;
  tone: HealthTone;
  value: string;
};

type EditableProfile = RepositoryProfileState;

const stepStateLabels: Record<OnboardingStepDisplayState, string> = {
  active: "Current",
  available: "Available",
  blocked: "Blocked",
  completed: "Complete",
  skipped: "Skipped",
};

const badgeToneClasses: Record<HealthTone, string> = {
  accent: "ui-badge-neutral",
  danger: "ui-badge-danger",
  neutral: "ui-badge-neutral",
  success: "ui-badge-neutral",
  warning: "ui-badge-neutral",
};

const railStateClasses: Record<OnboardingStepDisplayState, string> = {
  active: "border-border-strong bg-background text-foreground shadow-sm",
  available: "border-border bg-surface text-foreground hover:bg-surface-strong",
  blocked: "border-border bg-surface-muted text-muted opacity-70",
  completed: "border-border bg-surface text-muted hover:bg-surface-strong",
  skipped: "border-border bg-surface text-muted hover:bg-surface-strong",
};

function StepStateIcon({ state }: { state: OnboardingStepDisplayState }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "h-2 w-2 rounded-full",
        state === "active" ? "bg-foreground" : "bg-muted/60",
        state === "blocked" && "bg-border-strong",
      )}
    />
  );
}

function Badge({ children, tone }: { children: string; tone: HealthTone }) {
  return (
    <span className={cn("ui-badge whitespace-nowrap", badgeToneClasses[tone])}>
      <span className="ui-badge-dot" />
      {children}
    </span>
  );
}

function presenceBadge(configured: boolean) {
  return configured
    ? { tone: "success" as const, value: "Present" }
    : { tone: "warning" as const, value: "Missing" };
}

function setupHealthItems(health: OnboardingSetupHealth): HealthSummaryItem[] {
  const github = health.githubInstallation.connected
    ? {
        detail: health.githubInstallation.targetName ?? "Connected installation",
        tone: "success" as const,
        value: "Connected",
      }
    : {
        detail: "No active installation",
        tone: "warning" as const,
        value: "Missing",
      };
  const pipeline = health.defaultPipeline.configured
    ? {
        detail: `${health.defaultPipeline.stageCount} stages`,
        tone: "success" as const,
        value: "Ready",
      }
    : {
        detail: "Default pipeline unavailable",
        tone: "warning" as const,
        value: "Missing",
      };
  const linearKey = presenceBadge(health.linearKey.configured);
  const linearRouting = presenceBadge(health.linearRouting.configured);
  const agentConfig = presenceBadge(health.agentConfig.configured);
  const codex = health.codexConnection.connected
    ? { tone: "success" as const, value: "Connected" }
    : health.codexConnection.status === "expired"
      ? { tone: "danger" as const, value: "Expired" }
      : { tone: "warning" as const, value: "Missing" };
  const sandbox = health.latestSandboxCapabilityCheck
    ? health.latestSandboxCapabilityCheck.status === "success"
      ? { tone: "success" as const, value: "Ready" }
      : health.latestSandboxCapabilityCheck.status === "running"
        ? { tone: "accent" as const, value: "Running" }
        : { tone: "danger" as const, value: "Error" }
    : { tone: "neutral" as const, value: "No check" };

  return [
    { detail: github.detail, label: "GitHub", tone: github.tone, value: github.value },
    {
      detail: health.primaryRepositoryProfile.fullName ?? "No primary repository",
      label: "Repository",
      tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
      value: health.primaryRepositoryProfile.configured ? "Selected" : "Missing",
    },
    { detail: pipeline.detail, label: "Pipeline", tone: pipeline.tone, value: pipeline.value },
    {
      detail: health.linearKey.updatedAt ? "Credential stored" : "Workspace secret required",
      label: "Linear key",
      tone: linearKey.tone,
      value: linearKey.value,
    },
    {
      detail: health.linearRouting.updatedAt ? "Routes saved" : "Routing not mapped",
      label: "Linear routing",
      tone: linearRouting.tone,
      value: linearRouting.value,
    },
    {
      detail: health.agentConfig.configuredKeys.length
        ? health.agentConfig.configuredKeys.join(", ")
        : "Agent settings required",
      label: "Agent config",
      tone: agentConfig.tone,
      value: agentConfig.value,
    },
    {
      detail: health.codexConnection.updatedAt ? "Token available" : "Account connection required",
      label: "Codex",
      tone: codex.tone,
      value: codex.value,
    },
    {
      detail: health.latestSandboxCapabilityCheck?.checkedAt ?? "Run a capability check",
      label: "Sandbox",
      tone: sandbox.tone,
      value: sandbox.value,
    },
  ];
}

function stepHealthItems(
  step: WorkspaceOnboardingStep,
  health: OnboardingSetupHealth,
): StepHealthItem[] {
  switch (step) {
    case "github":
      return [
        {
          label: "Installation",
          tone: health.githubInstallation.connected ? "success" : "warning",
          value: health.githubInstallation.connected ? "Connected" : "Missing",
        },
        {
          label: "Target",
          tone: health.githubInstallation.targetName ? "success" : "neutral",
          value: health.githubInstallation.targetName ?? "Not selected",
        },
      ];
    case "repository":
      return [
        {
          label: "Repository setup",
          tone:
            health.repositorySetup.status === "ready"
              ? "success"
              : health.repositorySetup.status === "error"
                ? "danger"
                : health.repositorySetup.status === "conflict"
                  ? "warning"
                  : "neutral",
          value: health.repositorySetup.status,
        },
        {
          label: "Primary profile",
          tone: health.primaryRepositoryProfile.configured ? "success" : "warning",
          value: health.primaryRepositoryProfile.configured ? "Saved" : "Missing",
        },
      ];
    case "pipeline":
      return [
        {
          label: "Default pipeline",
          tone: health.defaultPipeline.configured ? "success" : "warning",
          value: health.defaultPipeline.configured ? "Ready" : "Missing",
        },
        {
          label: "Stages",
          tone: health.defaultPipeline.stageCount > 0 ? "success" : "warning",
          value: String(health.defaultPipeline.stageCount),
        },
      ];
    case "linear":
      return [
        {
          label: "Linear key",
          tone: health.linearKey.configured ? "success" : "warning",
          value: health.linearKey.configured ? "Present" : "Missing",
        },
        {
          label: "Routing",
          tone: health.linearRouting.configured ? "success" : "warning",
          value: health.linearRouting.configured ? "Mapped" : "Missing",
        },
      ];
    case "runtime":
      return [
        {
          label: "Agent config",
          tone: health.agentConfig.configured ? "success" : "warning",
          value: health.agentConfig.configured ? "Present" : "Missing",
        },
        {
          label: "Codex",
          tone: health.codexConnection.connected ? "success" : "warning",
          value: health.codexConnection.connected ? "Connected" : "Missing",
        },
        {
          label: "Sandbox",
          tone:
            health.latestSandboxCapabilityCheck?.status === "success"
              ? "success"
              : health.latestSandboxCapabilityCheck?.status === "error"
                ? "danger"
                : "neutral",
          value: health.latestSandboxCapabilityCheck?.status ?? "No check",
        },
      ];
    case "verify":
      return setupHealthItems(health).map((item) => ({
        label: item.label,
        tone: item.tone,
        value: item.value,
      }));
  }
}

function settingsHref(workspaceSlug: string, anchor: string) {
  return `${workspaceSettingsPath(workspaceSlug)}#${anchor}`;
}

function splitList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function joinList(value: readonly string[]) {
  return value.join("\n");
}

function applyGithubHealth(
  health: OnboardingSetupHealth,
  github: WorkspaceGitHubData,
): OnboardingSetupHealth {
  const primaryProfile = github.primaryProfile;
  const primaryRepository = primaryProfile
    ? github.repositories.find((repository) => repository.id === primaryProfile.githubRepositoryId)
    : null;
  const primaryRepositorySetup = primaryRepository?.onboarding ?? null;

  return {
    ...health,
    githubInstallation: {
      connected: Boolean(github.installation && !github.installation.suspended),
      installationId: github.installation?.installationId ?? null,
      status: github.installation ? "present" : "missing",
      suspended: github.installation?.suspended ?? null,
      targetName: github.installation?.targetName ?? null,
      updatedAt: github.installation?.updatedAt ?? null,
    },
    primaryRepositoryProfile: {
      configured: Boolean(primaryProfile),
      fullName: primaryRepository?.fullName ?? null,
      repositoryId: primaryProfile?.githubRepositoryId ?? null,
      status: primaryProfile ? "ready" : "missing",
    },
    repositorySetup: {
      configured: primaryRepositorySetup?.status === "ready",
      repositoryId:
        primaryRepositorySetup?.githubRepositoryId ?? primaryProfile?.githubRepositoryId ?? null,
      status: primaryRepositorySetup?.status ?? "placeholder",
    },
  };
}

function ProfileField({
  label,
  onChange,
  placeholder,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-[12px] font-medium text-muted">{label}</span>
      <input
        className="ui-input w-full"
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

function RepositoryProfileEditor({
  canManage,
  isBusy,
  isDirty,
  onChange,
  onInfer,
  onSave,
  profile,
}: {
  canManage: boolean;
  isBusy: boolean;
  isDirty: boolean;
  onChange: (profile: EditableProfile, dirty?: boolean) => void;
  onInfer: () => void;
  onSave: () => void;
  profile: EditableProfile;
}) {
  const confidence = isDirty ? "manual" : profile.inferenceConfidence;

  function update<K extends keyof EditableProfile>(key: K, value: EditableProfile[K]) {
    onChange({ ...profile, [key]: value, inferenceConfidence: "manual" }, true);
  }

  return (
    <div className="rounded-[6px] border border-border bg-background p-4">
      <div className="flex flex-col gap-3 border-b border-border pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold text-foreground">Repository profile</h3>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge
              tone={
                confidence === "high" ? "success" : confidence === "low" ? "warning" : "neutral"
              }
            >
              {confidence}
            </Badge>
            {profile.packageManager ? (
              <span className="ui-pill">{profile.packageManager}</span>
            ) : null}
            {profile.languageHints.map((hint) => (
              <span className="ui-pill" key={hint}>
                {hint}
              </span>
            ))}
            {profile.frameworkHints.map((hint) => (
              <span className="ui-pill" key={hint}>
                {hint}
              </span>
            ))}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <button
            className="ui-button"
            disabled={!canManage || isBusy}
            onClick={onInfer}
            type="button"
          >
            {isBusy ? "Inferring..." : "Refresh inference"}
          </button>
          <button
            className="ui-button-primary"
            disabled={!canManage || isBusy}
            onClick={onSave}
            type="button"
          >
            {isBusy ? "Saving..." : "Save profile"}
          </button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <ProfileField
          label="Package manager"
          onChange={(value) => update("packageManager", value.trim() || null)}
          placeholder="pnpm"
          value={profile.packageManager ?? ""}
        />
        <ProfileField
          label="Install command"
          onChange={(value) => update("installCommand", value.trim() || null)}
          placeholder="pnpm install"
          value={profile.installCommand ?? ""}
        />
        <ProfileField
          label="Build command"
          onChange={(value) => update("buildCommand", value.trim() || null)}
          placeholder="pnpm build"
          value={profile.buildCommand ?? ""}
        />
        <ProfileField
          label="Test command"
          onChange={(value) => update("testCommand", value.trim() || null)}
          placeholder="pnpm test"
          value={profile.testCommand ?? ""}
        />
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Language hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("languageHints", splitList(event.target.value))}
            value={joinList(profile.languageHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Framework hints</span>
          <textarea
            className="ui-textarea min-h-24 w-full"
            onChange={(event) => update("frameworkHints", splitList(event.target.value))}
            value={joinList(profile.frameworkHints)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Env key suggestions</span>
          <textarea
            className="ui-textarea min-h-28 w-full font-mono text-[12px]"
            onChange={(event) => update("envKeySuggestions", splitList(event.target.value))}
            value={joinList(profile.envKeySuggestions)}
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] font-medium text-muted">Setup notes</span>
          <textarea
            className="ui-textarea min-h-28 w-full"
            onChange={(event) => update("setupNotes", event.target.value)}
            value={profile.setupNotes}
          />
        </label>
      </div>

      <div className="mt-4">
        <p className="text-[12px] font-medium text-muted">Source files</p>
        {profile.inferenceSources.length === 0 ? (
          <p className="mt-1 text-[12px] leading-5 text-muted">No source files matched.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {profile.inferenceSources.map((source) => (
              <span className="ui-pill font-mono" key={source.path}>
                {source.path}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function StepBody({
  data,
  isSaving,
  onDataChange,
  onRepositoryProfileSaved,
  onSelectRepository,
  profileBusy,
  profileDirty,
  profileDraft,
  profileError,
  selectedRepositoryId,
  step,
  updateProfileDraft,
}: {
  data: WorkspaceOnboardingData;
  isSaving: boolean;
  onDataChange: (data: WorkspaceOnboardingData) => void;
  onRepositoryProfileSaved: () => void;
  onSelectRepository: (repository: WorkspaceGitHubRepository) => void;
  profileBusy: boolean;
  profileDirty: boolean;
  profileDraft: EditableProfile | null;
  profileError: string | null;
  selectedRepositoryId: string | null;
  step: WorkspaceOnboardingStep;
  updateProfileDraft: (profile: EditableProfile, dirty?: boolean) => void;
}) {
  const rows = stepHealthItems(step, data.setupHealth);
  const primaryHref =
    step === "github"
      ? settingsHref(data.workspace.slug, "github")
      : step === "pipeline"
        ? settingsHref(data.workspace.slug, "pipeline")
        : step === "linear"
          ? settingsHref(data.workspace.slug, "linear")
          : step === "runtime"
            ? settingsHref(data.workspace.slug, "coding-agent")
            : null;

  function updateGithub(github: WorkspaceGitHubData) {
    onDataChange({
      ...data,
      github,
      setupHealth: applyGithubHealth(data.setupHealth, github),
    });
  }

  if (step === "github") {
    return (
      <GitHubConnectionPanel
        canManage={data.canManage && !isSaving}
        github={data.github}
        onChange={updateGithub}
        source="onboarding"
        workspaceId={data.workspace.id}
      />
    );
  }

  if (step === "repository") {
    return (
      <div className="space-y-4">
        {profileError ? (
          <div
            className="rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
            role="alert"
          >
            {profileError}
          </div>
        ) : null}
        <GitHubConnectionPanel
          canManage={data.canManage && !isSaving}
          github={data.github}
          hideArchivedRepositories
          onChange={updateGithub}
          onSelectRepository={(repositoryId) => {
            const repository = data.github.repositories.find((item) => item.id === repositoryId);
            if (repository) onSelectRepository(repository);
          }}
          renderRepositoryDetails={(repository) =>
            selectedRepositoryId === repository.id && profileDraft ? (
              <RepositoryProfileEditor
                canManage={data.canManage && !isSaving}
                isBusy={profileBusy}
                isDirty={profileDirty}
                onChange={updateProfileDraft}
                onInfer={() => onSelectRepository(repository)}
                onSave={onRepositoryProfileSaved}
                profile={profileDraft}
              />
            ) : profileBusy && selectedRepositoryId === repository.id ? (
              <div className="rounded-[6px] border border-border bg-background px-3 py-2 text-[13px] text-muted">
                Inferring repository setup...
              </div>
            ) : null
          }
          selectedRepositoryId={selectedRepositoryId}
          source="onboarding"
          workspaceId={data.workspace.id}
        />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {rows.map((row) => (
          <div
            key={`${step}-${row.label}`}
            className="flex min-h-12 items-center justify-between gap-3 rounded-[6px] border border-border bg-surface-strong px-3 py-2"
          >
            <span className="min-w-0 text-[12px] font-medium text-muted">{row.label}</span>
            <Badge tone={row.tone}>{row.value}</Badge>
          </div>
        ))}
      </div>

      <div className="rounded-[6px] border border-border bg-background p-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <h3 className="text-[14px] font-semibold text-foreground">
              {step === "verify" ? "Setup health" : "Controls"}
            </h3>
            <p className="mt-1 text-[13px] leading-5 text-muted">
              {step === "verify"
                ? "Review the health summary, then complete setup when the required signals are ready."
                : "Use the linked settings area for now; this step will receive inline controls in a later integration issue."}
            </p>
          </div>
          {primaryHref ? (
            <Link className="ui-button shrink-0" href={primaryHref}>
              Open settings
            </Link>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StepRail({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <ol className="space-y-2">
      {items.map((step) => (
        <li key={step.id}>
          <button
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "flex w-full items-center gap-3 rounded-[8px] border px-3 py-2.5 text-left transition-colors",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-semibold">{step.title}</span>
              <span className="mt-0.5 block text-[11px] text-current opacity-75">
                {stepStateLabels[step.displayState]}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

function MobileStepControl({
  canManage,
  items,
  onSelect,
}: {
  canManage: boolean;
  items: ReturnType<typeof getOnboardingStepRailItems>;
  onSelect: (step: WorkspaceOnboardingStep) => void;
}) {
  return (
    <div className="border-b border-border bg-surface px-3 py-2 lg:hidden">
      <div className="flex gap-2 overflow-x-auto pb-1" aria-label="Setup steps">
        {items.map((step) => (
          <button
            key={step.id}
            type="button"
            aria-current={step.displayState === "active" ? "step" : undefined}
            className={cn(
              "inline-flex h-9 min-w-[112px] items-center justify-center gap-1.5 rounded-[6px] border px-2 text-[12px] font-medium",
              railStateClasses[step.displayState],
              (!canManage || !step.isNavigable) && "cursor-not-allowed",
            )}
            disabled={!canManage || !step.isNavigable}
            onClick={() => onSelect(step.id)}
          >
            <StepStateIcon state={step.displayState} />
            <span className="truncate">{step.shortTitle}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function SetupHealthSummary({ health }: { health: OnboardingSetupHealth }) {
  return (
    <aside className="ui-panel h-fit p-4">
      <h2 className="text-[14px] font-semibold text-foreground">Setup health</h2>
      <div className="mt-4 space-y-3">
        {setupHealthItems(health).map((item) => (
          <div key={item.label} className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[12px] font-medium text-foreground">{item.label}</p>
              <p className="mt-0.5 truncate text-[11px] text-muted">{item.detail}</p>
            </div>
            <Badge tone={item.tone}>{item.value}</Badge>
          </div>
        ))}
      </div>
    </aside>
  );
}

function initialProfileDraft(data: WorkspaceOnboardingData): EditableProfile | null {
  const primaryRepositoryId = data.github.primaryProfile?.githubRepositoryId;
  if (!primaryRepositoryId) return null;
  return (
    data.github.repositories.find((repository) => repository.id === primaryRepositoryId)?.profile ??
    data.github.primaryProfile
  );
}

export function OnboardingPageClient({ initialData }: OnboardingPageClientProps) {
  const router = useRouter();
  const [data, setData] = useState(initialData);
  const [error, setError] = useState<string | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileDirty, setProfileDirty] = useState(false);
  const [profileDraft, setProfileDraft] = useState<EditableProfile | null>(() =>
    initialProfileDraft(initialData),
  );
  const [profileError, setProfileError] = useState<string | null>(null);
  const [selectedRepositoryId, setSelectedRepositoryId] = useState<string | null>(
    initialData.github.primaryProfile?.githubRepositoryId ?? null,
  );
  const [savingAction, setSavingAction] = useState<string | null>(null);
  const saveInFlightRef = useRef(false);
  const onboarding = data.onboarding;
  const activeStep = ONBOARDING_STEPS.find((step) => step.id === onboarding.currentStep)!;
  const railItems = useMemo(() => getOnboardingStepRailItems(onboarding), [onboarding]);
  const canGoBack = onboardingStepIndex(onboarding.currentStep) > 0;
  const isCompleted = onboarding.status === "completed";
  const isSaving = savingAction !== null;
  const repositoryContinueBlocked =
    activeStep.id === "repository" && !data.setupHealth.primaryRepositoryProfile.configured;
  const skipAllowed = canSkipOnboardingStep(onboarding.currentStep);

  async function persistOnboarding(payload: WorkspaceOnboardingUpdatePayload, action: string) {
    if (!data.canManage || saveInFlightRef.current) return null;

    saveInFlightRef.current = true;
    setSavingAction(action);
    setError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/onboarding`, {
        body: JSON.stringify(payload),
        headers: { "content-type": "application/json" },
        method: "PATCH",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save onboarding state.");
      }

      const nextData = (await response.json()) as WorkspaceOnboardingData;
      setData(nextData);
      router.refresh();
      return nextData;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save onboarding state.");
      return null;
    } finally {
      saveInFlightRef.current = false;
      setSavingAction(null);
    }
  }

  async function continueSetup() {
    await persistOnboarding(buildOnboardingContinuePatch(onboarding), "continue");
  }

  async function skipStep() {
    const patch = buildOnboardingSkipPatch(onboarding);
    if (!patch) return;
    await persistOnboarding(patch, "skip");
  }

  async function goBack() {
    const previousStep = ONBOARDING_STEPS[onboardingStepIndex(onboarding.currentStep) - 1]?.id;
    if (!previousStep) return;
    const patch = buildOnboardingRailNavigationPatch(onboarding, previousStep);
    if (!patch) return;
    await persistOnboarding(patch, "back");
  }

  async function selectStep(step: WorkspaceOnboardingStep) {
    const patch = buildOnboardingRailNavigationPatch(onboarding, step);
    if (!patch) return;
    await persistOnboarding(patch, `rail:${step}`);
  }

  async function exitSetup() {
    const patch = data.canManage ? buildOnboardingExitPatch(onboarding) : null;
    const nextData = patch ? await persistOnboarding(patch, "exit") : data;
    if (nextData) {
      router.push(workspaceBasePath(data.workspace.slug));
    }
  }

  function updateProfileDraft(nextProfile: EditableProfile, dirty = false) {
    setProfileDraft(nextProfile);
    setProfileDirty(dirty);
  }

  async function inferRepositoryProfile(repository: WorkspaceGitHubRepository) {
    setSelectedRepositoryId(repository.id);
    setProfileDraft(null);
    setProfileDirty(false);
    setProfileError(null);
    setProfileBusy(true);

    try {
      const response = await fetch(
        `/api/workspaces/${data.workspace.id}/repositories/${repository.id}/inference`,
        { method: "POST" },
      );

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to infer repository setup.");
      }

      const body = (await response.json()) as { profile: EditableProfile };
      setProfileDraft(body.profile);
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to infer repository setup.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  async function selectRepository(repository: WorkspaceGitHubRepository) {
    setSelectedRepositoryId(repository.id);
    setProfileError(null);

    if (repository.profile) {
      setProfileDraft(repository.profile);
      setProfileDirty(false);
      return;
    }

    await inferRepositoryProfile(repository);
  }

  async function saveRepositoryProfile() {
    if (!profileDraft || !selectedRepositoryId || profileBusy) return;

    setProfileBusy(true);
    setProfileError(null);

    try {
      const response = await fetch(`/api/workspaces/${data.workspace.id}/repository-profile`, {
        body: JSON.stringify({
          buildCommand: profileDraft.buildCommand,
          envKeySuggestions: profileDraft.envKeySuggestions,
          frameworkHints: profileDraft.frameworkHints,
          githubRepositoryId: selectedRepositoryId,
          inferenceConfidence: profileDirty ? "manual" : profileDraft.inferenceConfidence,
          inferenceSources: profileDraft.inferenceSources,
          installCommand: profileDraft.installCommand,
          languageHints: profileDraft.languageHints,
          packageManager: profileDraft.packageManager,
          setupNotes: profileDraft.setupNotes,
          testCommand: profileDraft.testCommand,
        }),
        headers: { "content-type": "application/json" },
        method: "PUT",
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Failed to save repository profile.");
      }

      const body = (await response.json()) as { profile: EditableProfile };
      const nextGithub: WorkspaceGitHubData = {
        ...data.github,
        primaryProfile: body.profile,
        repositories: data.github.repositories.map((repository) => ({
          ...repository,
          profile:
            repository.id === body.profile.githubRepositoryId
              ? body.profile
              : repository.profile
                ? { ...repository.profile, isPrimary: false }
                : null,
        })),
      };
      const nextData = {
        ...data,
        github: nextGithub,
        setupHealth: applyGithubHealth(data.setupHealth, nextGithub),
      };

      setData(nextData);
      setProfileDraft(body.profile);
      setProfileDirty(false);

      if (onboarding.currentStep === "repository") {
        await persistOnboarding(buildOnboardingContinuePatch(onboarding), "repository-profile");
      }
    } catch (caught) {
      setProfileError(
        caught instanceof Error ? caught.message : "Failed to save repository profile.",
      );
    } finally {
      setProfileBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen flex-col bg-background text-foreground">
      <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 sm:px-6">
        <div className="min-w-0">
          <p className="text-[11px] font-medium text-muted">Workspace setup</p>
          <h1 className="truncate text-[15px] font-semibold text-foreground">
            {data.workspace.name}
          </h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {!data.canManage ? <Badge tone="neutral">Read only</Badge> : null}
          <button
            type="button"
            className="ui-button"
            disabled={isSaving}
            onClick={() => void exitSetup()}
          >
            {savingAction === "exit" ? "Exiting..." : "Exit setup"}
          </button>
        </div>
      </header>

      <MobileStepControl
        canManage={data.canManage && !isSaving}
        items={railItems}
        onSelect={selectStep}
      />

      <main
        id="main-content"
        className="grid flex-1 grid-cols-1 gap-4 p-4 pb-24 lg:grid-cols-[220px_minmax(0,1fr)_280px] lg:p-6 lg:pb-24"
      >
        <aside className="hidden lg:block">
          <div className="sticky top-6">
            <p className="mb-3 text-[11px] font-medium text-muted">Progress</p>
            <StepRail
              canManage={data.canManage && !isSaving}
              items={railItems}
              onSelect={selectStep}
            />
          </div>
        </aside>

        <section className="ui-panel min-w-0 p-5 sm:p-6">
          <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  tone={
                    isCompleted
                      ? "success"
                      : onboarding.status === "dismissed"
                        ? "neutral"
                        : "accent"
                  }
                >
                  {isCompleted
                    ? "Completed"
                    : onboarding.status === "dismissed"
                      ? "Dismissed"
                      : onboarding.status === "not_started"
                        ? "Not started"
                        : "In progress"}
                </Badge>
                <span className="text-[12px] text-muted">
                  Step {onboardingStepIndex(activeStep.id) + 1} of {ONBOARDING_STEPS.length}
                </span>
              </div>
              <h2 className="mt-3 text-[24px] font-semibold text-foreground">{activeStep.title}</h2>
              <p className="mt-1 max-w-2xl text-[13px] leading-5 text-muted">
                {activeStep.description}
              </p>
            </div>
            <Badge
              tone={
                railItems.find((step) => step.id === activeStep.id)?.displayState === "completed"
                  ? "success"
                  : railItems.find((step) => step.id === activeStep.id)?.displayState === "skipped"
                    ? "warning"
                    : "accent"
              }
            >
              {
                stepStateLabels[
                  railItems.find((step) => step.id === activeStep.id)?.displayState ?? "active"
                ]
              }
            </Badge>
          </div>

          {error ? (
            <div
              className="mt-5 rounded-[6px] border border-danger/20 bg-danger-soft px-3 py-2 text-[13px] text-danger"
              role="alert"
            >
              {error}
            </div>
          ) : null}

          <div className="mt-6">
            <StepBody
              data={data}
              isSaving={isSaving}
              onDataChange={setData}
              onRepositoryProfileSaved={() => void saveRepositoryProfile()}
              onSelectRepository={(repository) => void selectRepository(repository)}
              profileBusy={profileBusy}
              profileDirty={profileDirty}
              profileDraft={profileDraft}
              profileError={profileError}
              selectedRepositoryId={selectedRepositoryId}
              step={activeStep.id}
              updateProfileDraft={updateProfileDraft}
            />
          </div>
        </section>

        <SetupHealthSummary health={data.setupHealth} />
      </main>

      <footer className="sticky bottom-0 z-20 border-t border-border bg-surface/95 px-4 py-3 backdrop-blur sm:px-6">
        <div className="mx-auto flex max-w-[1280px] flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0 text-[12px] text-muted">
            {data.canManage
              ? "Progress is saved to this workspace."
              : "Ask a workspace admin to update setup progress."}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="ui-button"
              disabled={!data.canManage || !canGoBack || isSaving}
              onClick={() => void goBack()}
            >
              {savingAction === "back" ? "Saving..." : "Back"}
            </button>
            {skipAllowed && !isCompleted ? (
              <button
                type="button"
                className="ui-button"
                disabled={!data.canManage || isSaving}
                onClick={() => void skipStep()}
              >
                {savingAction === "skip" ? "Saving..." : "Skip"}
              </button>
            ) : null}
            <button
              type="button"
              className="ui-button-primary"
              disabled={!data.canManage || isCompleted || isSaving || repositoryContinueBlocked}
              onClick={() => void continueSetup()}
            >
              {isCompleted
                ? "Setup complete"
                : savingAction === "continue"
                  ? "Saving..."
                  : activeStep.id === "verify"
                    ? "Complete setup"
                    : "Continue"}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
