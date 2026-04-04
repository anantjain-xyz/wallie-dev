"use client";

import Link from "next/link";
import type { ChangeEvent, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";

import type {
  GitHubInstallationSummary,
  GitHubRepositorySummary,
  GitHubInstallResponse,
  GitHubRepositorySyncResponse,
} from "@/features/github/contracts";
import type {
  DeleteWorkspaceSecretResponse,
  ListWorkspaceSecretsResponse,
  UpsertWorkspaceSecretResponse,
  WorkspaceSecretPreview,
} from "@/lib/secrets/contracts";
import type { CreateStripePortalSessionResponse } from "@/lib/billing/contracts";
import type { WorkspaceAvatarUploadResponse } from "@/lib/storage/contracts";
import type { SettingsPageData } from "@/features/settings/data";

type SettingsPageClientProps = {
  initialData: SettingsPageData;
  searchState: {
    billingStatus: string | null;
    githubStatus: string | null;
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

function Section({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="ui-panel p-5">
      <h2 className="text-base font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
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

function ConfigState({
  missingKeys,
  title,
}: {
  missingKeys: string[];
  title: string;
}) {
  if (missingKeys.length === 0) {
    return null;
  }

  return (
    <div className="rounded-[6px] border border-warning/20 bg-warning-soft px-4 py-3 text-sm leading-6 text-warning">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">Missing env vars: {missingKeys.join(", ")}</p>
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
    const detail = payload?.missing?.length
      ? ` Missing: ${payload.missing.join(", ")}.`
      : "";

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

  switch (searchState.billingStatus) {
    case "returned":
      return {
        kind: "info",
        text: "Returned from the Stripe customer portal.",
      } satisfies FlashMessage;
    default:
      return null;
  }
}

export function SettingsPageClient({
  initialData,
  searchState,
}: SettingsPageClientProps) {
  const [flashMessage, setFlashMessage] = useState<FlashMessage | null>(
    initialFlashMessage(searchState),
  );
  const [workspaceAvatarUrl, setWorkspaceAvatarUrl] = useState(
    initialData.workspace.avatarUrl,
  );
  const [githubInstallation, setGithubInstallation] = useState<
    GitHubInstallationSummary | null
  >(initialData.github.installation);
  const [repositories, setRepositories] = useState<GitHubRepositorySummary[]>(
    initialData.github.repositories,
  );
  const [secrets, setSecrets] = useState<WorkspaceSecretPreview[]>([]);
  const [secretKey, setSecretKey] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [isRefreshingRepositories, setIsRefreshingRepositories] = useState(false);
  const [isLaunchingGitHubInstall, setIsLaunchingGitHubInstall] = useState(false);
  const [isOpeningBillingPortal, setIsOpeningBillingPortal] = useState(false);
  const [isUploadingAvatar, setIsUploadingAvatar] = useState(false);
  const [isLoadingSecrets, setIsLoadingSecrets] = useState(false);
  const [isSavingSecret, setIsSavingSecret] = useState(false);

  const isManager = initialData.canManage;
  const hasGitHubAppConfig = initialData.github.missingAppKeys.length === 0;
  const hasStripePortalConfig = initialData.billing.missingPortalKeys.length === 0;
  const truncatedStripeCustomerId = useMemo(() => {
    if (!initialData.workspace.stripeCustomerId) {
      return null;
    }

    const customerId = initialData.workspace.stripeCustomerId;

    return customerId.length > 14
      ? `${customerId.slice(0, 8)}…${customerId.slice(-4)}`
      : customerId;
  }, [initialData.workspace.stripeCustomerId]);

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
        const payload =
          await readResponseJson<ListWorkspaceSecretsResponse>(response);

        if (isActive) {
          setSecrets(payload.secrets);
        }
      } catch (error) {
        if (isActive) {
          setFlashMessage({
            kind: "error",
            text:
              error instanceof Error
                ? error.message
                : "Workspace secret loading failed.",
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
        text:
          error instanceof Error ? error.message : "GitHub install preparation failed.",
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
      const payload =
        await readResponseJson<GitHubRepositorySyncResponse>(response);

      setGithubInstallation(payload.installation);
      setRepositories(payload.repositories);
      setFlashMessage({
        kind: "success",
        text: "GitHub repositories refreshed.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "GitHub repository sync failed.",
      });
    } finally {
      setIsRefreshingRepositories(false);
    }
  }

  async function handleOpenBillingPortal() {
    setIsOpeningBillingPortal(true);

    try {
      const response = await fetch("/api/stripe/portal", {
        body: JSON.stringify({
          workspaceId: initialData.workspace.id,
        }),
        headers: {
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      const payload =
        await readResponseJson<CreateStripePortalSessionResponse>(response);

      window.location.assign(payload.url);
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Stripe portal launch failed.",
      });
      setIsOpeningBillingPortal(false);
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
      const payload =
        await readResponseJson<WorkspaceAvatarUploadResponse>(response);

      setWorkspaceAvatarUrl(payload.avatarUrl);
      setFlashMessage({
        kind: "success",
        text: "Workspace avatar updated.",
      });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text:
          error instanceof Error ? error.message : "Workspace avatar upload failed.",
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
      const payload =
        await readResponseJson<UpsertWorkspaceSecretResponse>(response);

      setSecrets((currentSecrets) => {
        const nextSecrets = currentSecrets.filter(
          (secret) => secret.key !== payload.secret.key,
        );

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
        text:
          error instanceof Error ? error.message : "Workspace secret save failed.",
      });
    } finally {
      setIsSavingSecret(false);
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
      const payload =
        await readResponseJson<DeleteWorkspaceSecretResponse>(response);

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
        text:
          error instanceof Error ? error.message : "Workspace secret deletion failed.",
      });
    }
  }

  return (
    <div className="grid gap-6">
      <header className="ui-panel p-5">
        <p className="ui-label">
          Workspace Admin
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-balance text-foreground">
          Settings
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted">
          Manage workspace identity, billing, GitHub sync, and encrypted secrets
          from one route.
        </p>
      </header>

      {flashMessage ? (
        <div
          aria-live="polite"
          className={`rounded-[6px] border px-4 py-3 text-sm ${toneClass(flashMessage.kind)}`}
          role="status"
        >
          {flashMessage.text}
        </div>
      ) : null}

      <div className="grid gap-6 xl:grid-cols-[0.95fr_1.05fr]">
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
                <p className="text-sm text-muted">
                  Tier: <span className="font-semibold text-foreground">{initialData.workspace.tier}</span>
                </p>
              </div>
            </div>

            <div className="ui-subpanel grid gap-3 p-4 text-sm text-foreground">
              <p>
                Billing cycle started{" "}
                <span className="font-semibold">
                  {dateFormatter.format(
                    new Date(initialData.workspace.currentBillingCycleStartAt),
                  )}
                </span>
              </p>
              <p>
                Successful Wallie runs this cycle{" "}
                <span className="font-semibold">
                  {initialData.workspace.successfulAgentRunsThisCycle}
                </span>
              </p>
              <p>
                Stripe customer{" "}
                <span className="font-mono text-xs">
                  {truncatedStripeCustomerId ?? "not created yet"}
                </span>
              </p>
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

        <Section title="Billing">
          <div className="space-y-4">
            <ConfigState
              missingKeys={initialData.billing.missingPortalKeys}
              title="Stripe portal disabled"
            />
            <ConfigState
              missingKeys={initialData.billing.missingWebhookKeys.filter(
                (key) => !initialData.billing.missingPortalKeys.includes(key),
              )}
              title="Stripe webhook sync disabled"
            />

            <div className="ui-subpanel p-5 text-sm leading-7 text-foreground">
              Customer portal is the Gate E billing surface. Subscription changes sync back into workspace tier and billing-cycle state through Stripe webhooks.
            </div>

            <button
              className="ui-button-primary"
              disabled={!isManager || !hasStripePortalConfig || isOpeningBillingPortal}
              onClick={() => void handleOpenBillingPortal()}
              type="button"
            >
              {isOpeningBillingPortal ? "Opening Portal…" : "Open Stripe Portal"}
            </button>
          </div>
        </Section>
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_0.9fr]">
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
              <div className="ui-subpanel space-y-4 p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-foreground">
                      Connected to {githubInstallation.targetType.toLowerCase()}{" "}
                      <span className="font-mono">{githubInstallation.targetName}</span>
                    </p>
                    <p className="mt-1 text-sm text-muted">
                      Installation #{githubInstallation.installationId} · last synced{" "}
                      {dateFormatter.format(new Date(githubInstallation.updatedAt))}
                    </p>
                    {githubInstallation.suspended ? (
                      <p className="mt-2 text-sm font-semibold text-amber-950">
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
                      <div
                        className="ui-muted-panel p-4"
                        key={repository.id}
                      >
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
                              <span>{repository.defaultProgrammingLanguage ?? "language unknown"}</span>
                              <span>{repository.defaultBranch ?? "no default branch"}</span>
                              {repository.isPrivate ? <span>private</span> : <span>public</span>}
                              {repository.isArchived ? <span>archived</span> : null}
                            </div>
                          </div>
                        </div>
                        {repository.description ? (
                          <p className="mt-3 text-sm leading-6 text-muted">
                            {repository.description}
                          </p>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>
            ) : (
              <div className="ui-subpanel space-y-4 p-5">
                <p className="text-sm leading-7 text-foreground">
                  Install the workspace GitHub App to sync repositories and let issue PR metadata flow back into Wallie.
                </p>
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

        <Section title="Secrets">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-muted">
              Secret values never come back to the client. Wallie shows preview-only rows and writes encrypted values through route handlers.
            </p>

            {isManager ? (
              <>
                <div className="ui-subpanel space-y-3 p-4">
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
                  ) : secrets.length === 0 ? (
                    <div className="ui-subpanel p-4 text-sm text-muted">
                      No workspace secrets yet.
                    </div>
                  ) : (
                    secrets.map((secret) => (
                      <div
                        className="ui-subpanel flex flex-wrap items-center justify-between gap-3 p-4"
                        key={secret.id}
                      >
                        <div>
                          <p className="text-sm font-semibold text-foreground">
                            {secret.key}
                          </p>
                          <p className="mt-1 font-mono text-xs uppercase tracking-[0.14em] text-muted">
                            {secret.valuePreview ?? "preview unavailable"}
                          </p>
                        </div>
                        <button
                          className="ui-button-danger"
                          onClick={() => void handleDeleteSecret(secret.key)}
                          type="button"
                        >
                          Delete
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <div className="ui-subpanel p-5 text-sm leading-7 text-muted">
                Workspace admins can manage encrypted secret previews from this surface.
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
