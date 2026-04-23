"use client";

import Link from "next/link";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useState } from "react";

import type {
  GitHubInstallationSummary,
  GitHubRepositorySummary,
  GitHubInstallResponse,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type {
  SlackDisconnectResponse,
  SlackInstallationSummary,
  SlackInstallResponse,
} from "@/features/slack/contracts";
import type {
  DeleteWorkspaceSecretResponse,
  ListWorkspaceSecretsResponse,
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";
import type { WorkspaceAvatarUploadResponse } from "@/lib/storage/contracts";
import type {
  AgentConfigMap,
  SettingsPageData,
  WorkspaceUsageData,
} from "@/features/settings/data";
import type { UpsertAgentConfigResponse } from "@/app/api/agent-config/route";
import { CodexConnectionPanel } from "@/features/settings/codex-connection-panel";

type SettingsPageClientProps = {
  initialData: SettingsPageData;
  searchState: {
    githubStatus: string | null;
    slackStatus: string | null;
    codexStatus: string | null;
  };
};

type FlashMessage = {
  kind: "error" | "info" | "success";
  text: string;
};

const dateFormatter = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const interactiveLinkClass =
  "font-semibold text-foreground transition-colors duration-150 hover:text-accent focus-visible:rounded-[4px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30";

function Section({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section className="space-y-5 rounded-[20px] bg-surface px-5 py-5 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_12px_28px_rgba(16,24,40,0.05)] sm:px-6 sm:py-6">
      <h2 className="text-base font-semibold tracking-tight text-balance text-foreground">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function toneClass(kind: FlashMessage["kind"]) {
  switch (kind) {
    case "error":
      return "border-danger/20 bg-danger-soft text-danger";
    case "info":
      return "border-accent/20 bg-accent-soft text-accent";
    default:
      return "border-success/20 bg-success-soft text-success";
  }
}

function ConfigState({ missingKeys, title }: { missingKeys: string[]; title: string }) {
  if (missingKeys.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-[6px] border border-warning/20 bg-warning-soft px-4 py-3 text-sm leading-6 text-warning">
      <p className="font-semibold">{title}</p>
      <p>Missing env vars: {missingKeys.join(", ")}</p>
    </div>
  );
}

function AvatarFallback({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <div className="ui-subpanel flex h-20 w-20 items-center justify-center text-2xl font-semibold text-foreground">
      {initial}
    </div>
  );
}

async function readResponseJson<T>(response: Response) {
  const payload = (await response.json().catch(() => null)) as
    | (T & {
        code?: string;
        error?: string;
        missing?: string[];
      })
    | null;

  if (!response.ok) {
    const detail = payload?.missing?.length ? ` Missing: ${payload.missing.join(", ")}.` : "";

    throw new Error((payload?.error ?? "Request failed.") + detail);
  }

  if (!payload) {
    throw new Error("Request returned an empty response.");
  }

  return payload;
}

function initialFlashMessage(searchState: SettingsPageClientProps["searchState"]) {
  switch (searchState.githubStatus) {
    case "connected":
      return {
        kind: "success",
        text: "GitHub App installation connected and repositories synced.",
      } satisfies FlashMessage;
    case "config_missing":
      return {
        kind: "error",
        text: "GitHub install completed, but Wallie is missing server config needed to finish the sync.",
      } satisfies FlashMessage;
    case "failed":
      return {
        kind: "error",
        text: "GitHub installation callback failed. Try the install flow again after checking server config.",
      } satisfies FlashMessage;
    case "invalid_state":
      return {
        kind: "error",
        text: "GitHub installation state expired or could not be verified. Start the install flow again from settings.",
      } satisfies FlashMessage;
    default:
      break;
  }

  switch (searchState.slackStatus) {
    case "connected":
      return {
        kind: "success",
        text: "Slack workspace connected. Wallie can now respond to mentions on Linear issues.",
      } satisfies FlashMessage;
    case "config_missing":
      return {
        kind: "error",
        text: "Slack install completed, but Wallie is missing server config needed to finish the sync.",
      } satisfies FlashMessage;
    case "failed":
      return {
        kind: "error",
        text: "Slack OAuth callback failed. Try the install flow again after checking server config.",
      } satisfies FlashMessage;
    case "invalid_state":
      return {
        kind: "error",
        text: "Slack installation state expired or could not be verified. Start the install flow again from settings.",
      } satisfies FlashMessage;
    default:
      return null;
  }
}

function AgentConfigField({
  configKey,
  description,
  disabled,
  label,
  onSave,
  options,
  placeholder,
  type,
  value,
}: {
  configKey: string;
  description: string;
  disabled: boolean;
  label: string;
  onSave: (key: string, value: unknown) => Promise<void>;
  options?: string[];
  placeholder?: string;
  type: "number" | "select" | "text";
  value: unknown;
}) {
  const currentValue = typeof value === "string" || typeof value === "number" ? String(value) : "";
  const [draft, setDraft] = useState(currentValue);
  const isDirty = draft !== currentValue;

  function handleSave() {
    const parsed = type === "number" ? Number(draft) : draft;
    if (type === "number" && Number.isNaN(parsed)) return;
    void onSave(configKey, parsed);
  }

  return (
    <div className="ui-subpanel space-y-4 p-4">
      <label className="space-y-2 text-sm font-semibold text-foreground">
        <span>{label}</span>
        {type === "select" && options ? (
          <select
            className="ui-input"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          >
            <option value="">Not configured</option>
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        ) : (
          <input
            autoComplete="off"
            className="ui-input"
            disabled={disabled}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={placeholder}
            type={type === "number" ? "number" : "text"}
            value={draft}
          />
        )}
      </label>
      <p className="text-xs leading-5 text-muted">{description}</p>
      <div className="flex justify-end">
        <button
          className="ui-button-primary"
          disabled={disabled || !isDirty}
          onClick={handleSave}
          type="button"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

function UsageSummary({ usage }: { usage: WorkspaceUsageData }) {
  return (
    <div className="space-y-4">
      <p className="text-sm leading-7 text-muted">
        Aggregate token usage and costs across all agent runs in this workspace.
      </p>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Total Runs</p>
          <p className="text-lg font-semibold text-foreground">{usage.totalRuns}</p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Input Tokens</p>
          <p className="text-lg font-semibold text-foreground">
            {formatTokens(usage.totalInputTokens)}
          </p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Output Tokens</p>
          <p className="text-lg font-semibold text-foreground">
            {formatTokens(usage.totalOutputTokens)}
          </p>
        </div>
        <div className="ui-subpanel space-y-1 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Total Cost</p>
          <p className="text-lg font-semibold text-foreground">${usage.totalCostUsd.toFixed(2)}</p>
        </div>
      </div>
    </div>
  );
}

export function SettingsPageClient({ initialData, searchState }: SettingsPageClientProps) {
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(
    initialFlashMessage(searchState),
  );
  const [workspaceAvatarUrl, setWorkspaceAvatarUrl] = useState(initialData.workspace.avatarUrl);
  const [githubInstallation, setGithubInstallation] = useState<GitHubInstallationSummary | null>(
    initialData.github.installation,
  );
  const [repositories, setRepositories] = useState<GitHubRepositorySummary[]>(
    initialData.github.repositories,
  );
  const [secrets, setSecrets] = useState<WorkspaceSecretPreview[]>([]);
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [isRefreshingRepositories, setIsRefreshingRepositories] = useState(false);
  const [isLaunchingGitHubInstall, setIsLaunchingGitHubInstall] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isLoadingSecrets, setIsLoadingSecrets] = useState(false);
  const [isSavingSecret, setIsSavingSecret] = useState(false);
  const [slackInstallation, setSlackInstallation] = useState<SlackInstallationSummary | null>(
    initialData.slack.installation,
  );
  const [isLaunchingSlackInstall, setIsLaunchingSlackInstall] = useState(false);
  const [isDisconnectingSlack, setIsDisconnectingSlack] = useState(false);
  const [isTestingLinear, setIsTestingLinear] = useState(false);
  const [linearApiKeyDraft, setLinearApiKeyDraft] = useState("");
  const [isSavingLinearKey, setIsSavingLinearKey] = useState(false);
  const [isDeletingLinearKey, setIsDeletingLinearKey] = useState(false);
  const [agentConfig, setAgentConfig] = useState<AgentConfigMap>(initialData.agentConfig);
  const [isSavingAgentConfig, setIsSavingAgentConfig] = useState(false);

  const isManager = initialData.canManage;
  const hasGitHubAppConfig = initialData.github.missingAppKeys.length === 0;
  const hasSlackAppConfig = initialData.slack.missingAppKeys.length === 0;
  const linearSecret = secrets.find((secret) => secret.key === "LINEAR_API_KEY") ?? null;
  const otherSecrets = secrets.filter((secret) => secret.key !== "LINEAR_API_KEY");

  useEffect(() => {
    if (!isManager) {
      return;
    }

    let isActive = true;

    async function loadSecrets() {
      setIsLoadingSecrets(true);

      try {
        const response = await fetch(
          `/api/secrets?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
          {
            cache: "no-store",
          },
        );
        const payload = await readResponseJson<ListWorkspaceSecretsResponse>(response);

        if (isActive) {
          setSecrets(payload.secrets);
        }
      } catch (error) {
        if (isActive) {
          setFlashMessage({
            kind: "error",
            text: error instanceof Error ? error.message : "Workspace secret loading failed.",
          });
        }
      } finally {
        if (isActive) {
          setIsLoadingSecrets(false);
        }
      }
    }

    void loadSecrets();

    return () => {
      isActive = false;
    };
  }, [initialData.workspace.id, isManager]);

  async function handleGitHubInstall() {
    setIsLaunchingGitHubInstall(true);

    try {
      const response = await fetch(
        `/api/github/install?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        {
          method: "GET",
        },
      );
      const payload = await readResponseJson<GitHubInstallResponse>(response);

      window.location.assign(payload.installUrl);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "GitHub install preparation failed.",
      });
      setIsLaunchingGitHubInstall(false);
    }
  }

  async function handleRefreshRepositories() {
    setIsRefreshingRepositories(true);

    try {
      const response = await fetch("/api/github/refresh-repositories", {
        body: JSON.stringify({
          workspaceId: initialData.workspace.id,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await readResponseJson<GitHubRepositorySyncResponse>(response);

      setGithubInstallation(payload.installation);
      setRepositories(payload.repositories);
      setFlashMessage({
        kind: "success",
        text: "GitHub repositories refreshed.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "GitHub repository sync failed.",
      });
    } finally {
      setIsRefreshingRepositories(false);
    }
  }

  async function handleAvatarInputChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];

    if (!file) {
      return;
    }

    setIsUploadingAvatar(true);

    try {
      const formData = new FormData();

      formData.append("file", file);

      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(initialData.workspace.id)}/avatar`,
        {
          body: formData,
          method: "POST",
        },
      );
      const payload = await readResponseJson<WorkspaceAvatarUploadResponse>(response);

      setWorkspaceAvatarUrl(payload.avatarUrl);
      setFlashMessage({
        kind: "success",
        text: "Workspace avatar updated.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Workspace avatar upload failed.",
      });
    } finally {
      event.target.value = "";
      setIsUploadingAvatar(false);
    }
  }

  async function handleSaveSecret() {
    if (!secretKey.trim() || !secretValue.trim()) {
      setFlashMessage({
        kind: "error",
        text: "Enter both a secret key and a secret value.",
      });
      return;
    }

    setIsSavingSecret(true);

    try {
      const response = await fetch("/api/secrets", {
        body: JSON.stringify({
          key: secretKey.trim().toUpperCase(),
          value: secretValue,
          workspaceId: initialData.workspace.id,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload = await readResponseJson<UpsertWorkspaceSecretResponse>(response);

      setSecrets((currentSecrets) => {
        const nextSecrets = currentSecrets.filter((secret) => secret.key !== payload.secret.key);

        nextSecrets.push(payload.secret);
        nextSecrets.sort((left, right) => left.key.localeCompare(right.key));

        return nextSecrets;
      });
      setSecretKey("");
      setSecretValue("");
      setFlashMessage({
        kind: "success",
        text: `Saved preview for ${payload.secret.key}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Workspace secret save failed.",
      });
    } finally {
      setIsSavingSecret(false);
    }
  }

  async function handleSlackInstall() {
    setIsLaunchingSlackInstall(true);

    try {
      const response = await fetch(
        `/api/slack/install?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        {
          method: "GET",
        },
      );
      const payload = await readResponseJson<SlackInstallResponse>(response);

      window.location.assign(payload.installUrl);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Slack install preparation failed.",
      });
      setIsLaunchingSlackInstall(false);
    }
  }

  async function handleSlackDisconnect() {
    if (!slackInstallation) {
      return;
    }

    if (!window.confirm("Disconnect this Slack workspace from Wallie?")) {
      return;
    }

    setIsDisconnectingSlack(true);

    try {
      const response = await fetch(
        `/api/slack/installations/${encodeURIComponent(
          slackInstallation.id,
        )}?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        {
          method: "DELETE",
        },
      );
      await readResponseJson<SlackDisconnectResponse>(response);

      setSlackInstallation(null);
      setFlashMessage({
        kind: "success",
        text: "Slack workspace disconnected.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Slack disconnect failed.",
      });
    } finally {
      setIsDisconnectingSlack(false);
    }
  }

  async function handleTestLinearConnection() {
    setIsTestingLinear(true);

    try {
      const response = await fetch(
        `/api/linear/test-connection?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        {
          method: "POST",
        },
      );
      await readResponseJson<{ ok: true }>(response);

      setFlashMessage({
        kind: "success",
        text: "Linear API key verified. Wallie can read issues from this workspace.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Linear API verification failed.",
      });
    } finally {
      setIsTestingLinear(false);
    }
  }

  async function handleSaveLinearKey() {
    const value = linearApiKeyDraft.trim();

    if (!value) {
      setFlashMessage({ kind: "error", text: "Paste a Linear API key first." });
      return;
    }

    setIsSavingLinearKey(true);

    try {
      const response = await fetch("/api/secrets", {
        body: JSON.stringify({
          key: "LINEAR_API_KEY",
          value,
          workspaceId: initialData.workspace.id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const payload = await readResponseJson<UpsertWorkspaceSecretResponse>(response);

      setSecrets((current) => {
        const next = current.filter((secret) => secret.key !== payload.secret.key);
        next.push(payload.secret);
        next.sort((left, right) => left.key.localeCompare(right.key));
        return next;
      });
      setLinearApiKeyDraft("");
      setFlashMessage({ kind: "success", text: "Linear API key saved." });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Linear API key save failed.",
      });
    } finally {
      setIsSavingLinearKey(false);
    }
  }

  async function handleDeleteLinearKey() {
    if (!window.confirm("Remove the Linear API key for this workspace?")) {
      return;
    }

    setIsDeletingLinearKey(true);

    try {
      const response = await fetch(
        `/api/secrets/${encodeURIComponent("LINEAR_API_KEY")}?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        { method: "DELETE" },
      );
      const payload = await readResponseJson<DeleteWorkspaceSecretResponse>(response);

      setSecrets((current) => current.filter((secret) => secret.key !== payload.deletedKey));
      setFlashMessage({ kind: "success", text: "Linear API key removed." });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Linear API key deletion failed.",
      });
    } finally {
      setIsDeletingLinearKey(false);
    }
  }

  async function handleDeleteSecret(key: string) {
    if (!window.confirm(`Delete ${key}?`)) {
      return;
    }

    try {
      const response = await fetch(
        `/api/secrets/${encodeURIComponent(key)}?workspaceId=${encodeURIComponent(initialData.workspace.id)}`,
        {
          method: "DELETE",
        },
      );
      const payload = await readResponseJson<DeleteWorkspaceSecretResponse>(response);

      setSecrets((currentSecrets) =>
        currentSecrets.filter((secret) => secret.key !== payload.deletedKey),
      );
      setFlashMessage({
        kind: "success",
        text: `Deleted ${payload.deletedKey}.`,
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Workspace secret deletion failed.",
      });
    }
  }

  async function handleSaveAgentConfig(key: string, value: unknown) {
    setIsSavingAgentConfig(true);

    try {
      const response = await fetch("/api/agent-config", {
        body: JSON.stringify({
          key,
          value,
          workspaceId: initialData.workspace.id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await readResponseJson<UpsertAgentConfigResponse>(response);

      setAgentConfig((current) => ({ ...current, [key]: value }));
      setFlashMessage({ kind: "success", text: `Saved ${key}.` });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Agent config save failed.",
      });
    } finally {
      setIsSavingAgentConfig(false);
    }
  }

  return (
    <div className="min-h-full bg-[#f6f5f2] px-4 py-5 sm:px-6 sm:py-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3 rounded-[24px] bg-surface px-6 py-6 shadow-[0_1px_2px_rgba(16,24,40,0.04),0_14px_32px_rgba(16,24,40,0.06)] sm:px-8 sm:py-8">
          <p className="ui-label">Workspace Admin</p>
          <h1 className="text-3xl font-semibold tracking-tight text-balance text-foreground">
            Settings
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-muted">
            Manage workspace identity, GitHub sync, Slack installation, and encrypted secrets from
            one route.
          </p>
        </header>

        {flashMessage ? (
          <div
            aria-live="polite"
            className={`rounded-[14px] border px-4 py-3 text-sm shadow-[0_1px_2px_rgba(16,24,40,0.04)] ${toneClass(flashMessage.kind)}`}
            role="status"
          >
            {flashMessage.text}
          </div>
        ) : null}

        <Section title="Workspace">
          <div className="space-y-5">
            <div className="flex flex-wrap items-center gap-4">
              {workspaceAvatarUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  alt={`${initialData.workspace.name} avatar`}
                  className="h-20 w-20 rounded-[1.75rem] border border-border/70 object-cover"
                  height={80}
                  src={workspaceAvatarUrl}
                  width={80}
                />
              ) : (
                <AvatarFallback name={initialData.workspace.name} />
              )}

              <div className="space-y-1">
                <p className="text-xl font-semibold tracking-tight text-foreground">
                  {initialData.workspace.name}
                </p>
                <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">
                  /w/{initialData.workspace.slug}
                </p>
              </div>
            </div>

            {isManager ? (
              <label className="ui-subpanel flex w-full cursor-pointer items-center justify-between px-4 py-4 text-sm font-semibold text-foreground transition-[border-color,box-shadow] duration-150 hover:border-accent/45">
                <span>
                  {isUploadingAvatar ? "Uploading Workspace Avatar…" : "Upload Workspace Avatar"}
                </span>
                <input
                  accept=".jpg,.jpeg,.png,.webp"
                  className="sr-only"
                  disabled={isUploadingAvatar}
                  onChange={handleAvatarInputChange}
                  type="file"
                />
              </label>
            ) : (
              <p className="text-sm leading-6 text-muted">
                Workspace admins can change the avatar and manage integrations from this page.
              </p>
            )}
          </div>
        </Section>

        <Section title="GitHub">
          <div className="space-y-4">
            <ConfigState
              missingKeys={initialData.github.missingAppKeys}
              title="GitHub install flow disabled"
            />
            <ConfigState
              missingKeys={initialData.github.missingWebhookKeys.filter(
                (key) => !initialData.github.missingAppKeys.includes(key),
              )}
              title="GitHub webhook sync disabled"
            />

            {githubInstallation ? (
              <div className="ui-subpanel space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      Connected to{" "}
                      {githubInstallation.targetType.charAt(0).toUpperCase() +
                        githubInstallation.targetType.slice(1).toLowerCase()}{" "}
                      <span className="font-mono">{githubInstallation.targetName}</span>
                    </p>
                    <p className="text-sm text-muted">
                      Installation #{githubInstallation.installationId} · last synced{" "}
                      {dateFormatter.format(new Date(githubInstallation.updatedAt))}
                    </p>
                    {githubInstallation.suspended ? (
                      <p className="text-sm font-semibold text-amber-950">
                        GitHub marked this installation as suspended.
                      </p>
                    ) : null}
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      className="ui-button"
                      disabled={!isManager || isRefreshingRepositories}
                      onClick={() => void handleRefreshRepositories()}
                      type="button"
                    >
                      {isRefreshingRepositories ? "Refreshing…" : "Refresh Repositories"}
                    </button>
                    <Link
                      className="ui-button"
                      href={githubInstallation.installationUrl}
                      rel="noreferrer"
                      target="_blank"
                    >
                      Manage on GitHub
                    </Link>
                  </div>
                </div>

                <div className="space-y-3">
                  {repositories.length === 0 ? (
                    <div className="ui-muted-panel p-4 text-sm leading-6 text-muted">
                      No repositories are synced yet.
                    </div>
                  ) : (
                    repositories.map((repository) => (
                      <div className="ui-muted-panel space-y-3 p-4" key={repository.id}>
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-2">
                            <a
                              className={`text-sm ${interactiveLinkClass}`}
                              href={repository.htmlUrl}
                              rel="noreferrer"
                              target="_blank"
                            >
                              {repository.fullName}
                            </a>
                            <div className="flex flex-wrap gap-2 text-xs uppercase tracking-[0.16em] text-muted">
                              <span>
                                {repository.defaultProgrammingLanguage ?? "language unknown"}
                              </span>
                              <span>{repository.defaultBranch ?? "no default branch"}</span>
                              {repository.isPrivate ? <span>private</span> : <span>public</span>}
                              {repository.isArchived ? <span>archived</span> : null}
                            </div>
                          </div>
                        </div>
                        {repository.description ? (
                          <p className="text-sm leading-6 text-muted">{repository.description}</p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="ui-subpanel space-y-4 p-4">
                <div className="space-y-2">
                  <p className="text-sm leading-7 text-foreground">
                    Install the workspace GitHub App so PR status appears on each issue
                    automatically and Wallie can open PRs from agent runs.
                  </p>
                  <p className="text-xs leading-6 text-muted">
                    Workspace admins only. The app requests read access to repositories and
                    metadata, plus write access to pull requests on the repos you select during
                    install.
                  </p>
                </div>
                <button
                  className="ui-button-primary"
                  disabled={!isManager || !hasGitHubAppConfig || isLaunchingGitHubInstall}
                  onClick={() => void handleGitHubInstall()}
                  type="button"
                >
                  {isLaunchingGitHubInstall ? "Preparing Install…" : "Install GitHub App"}
                </button>
              </div>
            )}
          </div>
        </Section>

        <Section title="Slack">
          <div className="space-y-4">
            <ConfigState
              missingKeys={initialData.slack.missingAppKeys}
              title="Slack install flow disabled"
            />

            {slackInstallation ? (
              <div className="ui-subpanel space-y-4 p-4">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <p className="text-sm font-semibold text-foreground">
                      Connected to{" "}
                      <span className="font-mono">
                        {slackInstallation.teamName ?? slackInstallation.teamId}
                      </span>
                    </p>
                    <p className="text-sm text-muted">
                      Installed {dateFormatter.format(new Date(slackInstallation.installedAt))} ·
                      Team ID <span className="font-mono">{slackInstallation.teamId}</span>
                    </p>
                  </div>

                  <div className="flex flex-wrap gap-3">
                    <button
                      className="ui-button"
                      disabled={!isManager || !hasSlackAppConfig || isLaunchingSlackInstall}
                      onClick={() => void handleSlackInstall()}
                      type="button"
                    >
                      {isLaunchingSlackInstall ? "Preparing…" : "Reinstall"}
                    </button>
                    <button
                      className="ui-button-danger"
                      disabled={!isManager || isDisconnectingSlack}
                      onClick={() => void handleSlackDisconnect()}
                      type="button"
                    >
                      {isDisconnectingSlack ? "Disconnecting…" : "Disconnect"}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="ui-subpanel space-y-4 p-4">
                <div className="space-y-2">
                  <p className="text-sm leading-7 text-foreground">
                    Connect Slack so the Wallie product agent can pick up @mentions on Linear
                    issues, draft a spec, and post it back for PM review.
                  </p>
                  <p className="text-xs leading-6 text-muted">
                    Workspace admins only. Wallie requests{" "}
                    <span className="font-mono">app_mentions:read</span>,{" "}
                    <span className="font-mono">chat:write</span>, and{" "}
                    <span className="font-mono">chat:write.public</span> so it can reply in threads
                    where it&apos;s mentioned.
                  </p>
                </div>
                <button
                  className="ui-button-primary"
                  disabled={!isManager || !hasSlackAppConfig || isLaunchingSlackInstall}
                  onClick={() => void handleSlackInstall()}
                  type="button"
                >
                  {isLaunchingSlackInstall ? "Preparing Install…" : "Install Slack App"}
                </button>
              </div>
            )}
          </div>
        </Section>

        <Section title="Linear">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-muted">
              Paste a Linear personal API key so Wallie can read issues referenced in sessions and
              Slack mentions. Generate one at{" "}
              <a
                className={interactiveLinkClass}
                href="https://linear.app/settings/account/security"
                rel="noreferrer"
                target="_blank"
              >
                linear.app/settings/account/security
              </a>
              .
            </p>

            {!isManager ? (
              <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
                Workspace admins can manage the Linear API key from this page.
              </div>
            ) : linearSecret ? (
              <div className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="space-y-1">
                  <p className="text-sm font-semibold text-foreground">Linear API key configured</p>
                  <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
                    {linearSecret.valuePreview ?? "preview unavailable"} · updated{" "}
                    {dateFormatter.format(new Date(linearSecret.updatedAt))}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    className="ui-button"
                    disabled={isTestingLinear}
                    onClick={() => void handleTestLinearConnection()}
                    type="button"
                  >
                    {isTestingLinear ? "Testing…" : "Test Connection"}
                  </button>
                  <button
                    className="ui-button-danger"
                    disabled={isDeletingLinearKey}
                    onClick={() => void handleDeleteLinearKey()}
                    type="button"
                  >
                    {isDeletingLinearKey ? "Removing…" : "Remove"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="ui-subpanel space-y-4 p-4">
                <label className="space-y-2 text-sm font-semibold text-foreground">
                  <span>Linear API Key</span>
                  <input
                    autoComplete="off"
                    className="ui-input font-mono"
                    name="linearApiKey"
                    onChange={(event) => setLinearApiKeyDraft(event.target.value)}
                    placeholder="lin_api_…"
                    spellCheck={false}
                    type="password"
                    value={linearApiKeyDraft}
                  />
                </label>
                <div className="flex justify-end">
                  <button
                    className="ui-button-primary"
                    disabled={isSavingLinearKey || !linearApiKeyDraft.trim()}
                    onClick={() => void handleSaveLinearKey()}
                    type="button"
                  >
                    {isSavingLinearKey ? "Saving…" : "Save Linear API Key"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </Section>

        <Section title="Secrets">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-muted">
              Secret values never come back to the client. Wallie shows preview-only rows and writes
              encrypted values through route handlers.
            </p>

            {isManager ? (
              <>
                <div className="ui-subpanel space-y-4 p-4">
                  <label className="space-y-2 text-sm font-semibold text-foreground">
                    <span>Secret Key</span>
                    <input
                      autoCapitalize="characters"
                      autoComplete="off"
                      className="ui-input"
                      name="secretKey"
                      onChange={(event) => setSecretKey(event.target.value)}
                      placeholder="ANTHROPIC_API_KEY…"
                      spellCheck={false}
                      value={secretKey}
                    />
                  </label>
                  <label className="space-y-2 text-sm font-semibold text-foreground">
                    <span>Secret Value</span>
                    <textarea
                      autoComplete="off"
                      className="ui-textarea min-h-28"
                      name="secretValue"
                      onChange={(event) => setSecretValue(event.target.value)}
                      placeholder="Paste the Secret Value…"
                      value={secretValue}
                    />
                  </label>
                  <div className="flex justify-end">
                    <button
                      className="ui-button-primary"
                      disabled={isSavingSecret}
                      onClick={() => void handleSaveSecret()}
                      type="button"
                    >
                      {isSavingSecret ? "Saving…" : "Save Secret"}
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  {isLoadingSecrets ? (
                    <div className="ui-subpanel p-4 text-sm text-muted">
                      Loading Secret Previews…
                    </div>
                  ) : otherSecrets.length === 0 ? (
                    <div className="ui-subpanel p-4 text-sm text-muted">
                      No workspace secrets yet.
                    </div>
                  ) : (
                    otherSecrets.map((secret) => (
                      <div
                        className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                        key={secret.id}
                      >
                        <div className="space-y-1">
                          <p className="text-sm font-semibold text-foreground">{secret.key}</p>
                          <p className="font-mono text-xs uppercase tracking-[0.14em] text-muted">
                            {secret.valuePreview ?? "preview unavailable"}
                          </p>
                        </div>
                        <div className="flex flex-wrap gap-2">
                          <button
                            className="ui-button-danger"
                            onClick={() => void handleDeleteSecret(secret.key)}
                            type="button"
                          >
                            Delete
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
                Workspace admins can manage encrypted secret previews from this surface.
              </div>
            )}
          </div>
        </Section>

        <Section title="Usage">
          <UsageSummary usage={initialData.usage} />
        </Section>

        <Section title="Coding Agent">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-muted">
              Configure how Wallie runs coding agents in this workspace. These settings apply to all
              sessions that trigger agent execution.
            </p>

            {isManager ? (
              <div className="space-y-4">
                <AgentConfigField
                  configKey="agent_provider"
                  description="Which agent CLI or API to use for coding tasks."
                  disabled={isSavingAgentConfig}
                  label="Agent Provider"
                  onSave={handleSaveAgentConfig}
                  options={["codex", "claude_code"]}
                  type="select"
                  value={agentConfig.agent_provider}
                />
                {(agentConfig.agent_provider ?? "codex") === "codex" ? (
                  <p className="text-xs leading-5 text-muted">
                    Each session runs with its creator&apos;s Codex account. Connect yours below
                    under &ldquo;Your Codex account&rdquo;.
                  </p>
                ) : null}
                <AgentConfigField
                  configKey="agent_model"
                  description="Model identifier passed to the agent provider."
                  disabled={isSavingAgentConfig}
                  label="Agent Model"
                  onSave={handleSaveAgentConfig}
                  placeholder="claude-sonnet-4-20250514"
                  type="text"
                  value={agentConfig.agent_model}
                />
                <AgentConfigField
                  configKey="concurrency_limit"
                  description="Max number of agent jobs that can run simultaneously."
                  disabled={isSavingAgentConfig}
                  label="Concurrency Limit"
                  onSave={handleSaveAgentConfig}
                  placeholder="1"
                  type="number"
                  value={agentConfig.concurrency_limit}
                />
                <AgentConfigField
                  configKey="stall_timeout_ms"
                  description="Time in milliseconds before a run with no activity is considered stalled."
                  disabled={isSavingAgentConfig}
                  label="Stall Timeout (ms)"
                  onSave={handleSaveAgentConfig}
                  placeholder="300000"
                  type="number"
                  value={agentConfig.stall_timeout_ms}
                />
                <AgentConfigField
                  configKey="max_retries"
                  description="Maximum automatic retries for failed agent runs."
                  disabled={isSavingAgentConfig}
                  label="Max Retries"
                  onSave={handleSaveAgentConfig}
                  placeholder="3"
                  type="number"
                  value={agentConfig.max_retries}
                />
              </div>
            ) : (
              <div className="ui-subpanel p-4 text-sm leading-7 text-muted">
                Workspace admins can configure coding agent settings from this page.
              </div>
            )}
          </div>
        </Section>

        <Section title="Your Codex account">
          <CodexConnectionPanel connectFlash={searchState.codexStatus} />
        </Section>
      </div>
    </div>
  );
}
