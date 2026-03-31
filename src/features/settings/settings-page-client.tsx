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

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  year: "numeric",
});

function Section({
  children,
  title,
}: {
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-[2rem] border border-border/90 bg-surface/95 p-6 shadow-[0_24px_80px_rgba(20,33,61,0.08)] backdrop-blur">
      <h2 className="text-lg font-semibold tracking-tight text-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  );
}

function toneClass(kind: FlashMessage["kind"]) {
  switch (kind) {
    case "error":
      return "border-rose-400/50 bg-rose-500/10 text-rose-900";
    case "info":
      return "border-sky-400/50 bg-sky-500/10 text-sky-950";
    default:
      return "border-emerald-400/45 bg-emerald-500/10 text-emerald-950";
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
    <div className="rounded-[1.3rem] border border-amber-400/45 bg-amber-500/10 px-4 py-3 text-sm leading-6 text-amber-950">
      <p className="font-semibold">{title}</p>
      <p className="mt-1">Missing env vars: {missingKeys.join(", ")}</p>
    </div>
  );
}

function AvatarFallback({ name }: { name: string }) {
  const initial = name.trim().charAt(0).toUpperCase() || "W";

  return (
    <div className="flex h-20 w-20 items-center justify-center rounded-[1.75rem] border border-border/70 bg-surface-strong/70 text-2xl font-semibold text-foreground">
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
      ? `${customerId.slice(0, 8)}...${customerId.slice(-4)}`
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
      {flashMessage ? (
        <div
          className={`rounded-[1.4rem] border px-5 py-4 text-sm ${toneClass(flashMessage.kind)}`}
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
                  src={workspaceAvatarUrl}
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

            <div className="grid gap-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4 text-sm text-foreground">
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
              <label className="flex w-full cursor-pointer items-center justify-between rounded-[1.5rem] border border-border/80 bg-background/70 px-4 py-4 text-sm font-semibold text-foreground transition hover:border-accent/45">
                <span>
                  {isUploadingAvatar ? "Uploading avatar..." : "Upload workspace avatar"}
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

            <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-foreground">
              Customer portal is the Gate E billing surface. Subscription changes sync back into workspace tier and billing-cycle state through Stripe webhooks.
            </div>

            <button
              className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={!isManager || !hasStripePortalConfig || isOpeningBillingPortal}
              onClick={() => void handleOpenBillingPortal()}
              type="button"
            >
              {isOpeningBillingPortal ? "Opening portal..." : "Open Stripe portal"}
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
              <div className="space-y-4 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5">
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
                      className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={!isManager || isRefreshingRepositories}
                      onClick={() => void handleRefreshRepositories()}
                      type="button"
                    >
                      {isRefreshingRepositories ? "Refreshing..." : "Refresh repositories"}
                    </button>
                    <Link
                      className="rounded-full border border-border/80 bg-background/80 px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-foreground transition hover:border-accent/40 hover:text-accent"
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
                    <div className="rounded-[1.4rem] border border-border/70 bg-background/70 p-4 text-sm leading-6 text-muted">
                      No repositories are synced yet.
                    </div>
                  ) : (
                    repositories.map((repository) => (
                      <div
                        className="rounded-[1.4rem] border border-border/70 bg-background/70 p-4"
                        key={repository.id}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="space-y-2">
                            <a
                              className="text-sm font-semibold text-foreground transition hover:text-accent"
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
              <div className="space-y-4 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5">
                <p className="text-sm leading-7 text-foreground">
                  Install the workspace GitHub App to sync repositories and let issue PR metadata flow back into Wallie.
                </p>
                <button
                  className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={!isManager || !hasGitHubAppConfig || isLaunchingGitHubInstall}
                  onClick={() => void handleGitHubInstall()}
                  type="button"
                >
                  {isLaunchingGitHubInstall ? "Preparing install..." : "Install GitHub App"}
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
                <div className="space-y-3 rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-4">
                  <input
                    className="w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                    onChange={(event) => setSecretKey(event.target.value)}
                    placeholder="ANTHROPIC_API_KEY"
                    value={secretKey}
                  />
                  <textarea
                    className="min-h-28 w-full rounded-[1rem] border border-border/80 bg-background/70 px-4 py-3 text-sm text-foreground outline-none transition focus:border-accent/45"
                    onChange={(event) => setSecretValue(event.target.value)}
                    placeholder="Secret value"
                    value={secretValue}
                  />
                  <div className="flex justify-end">
                    <button
                      className="rounded-full border border-accent/45 bg-accent px-5 py-3 text-xs font-semibold uppercase tracking-[0.18em] text-background transition hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isSavingSecret}
                      onClick={() => void handleSaveSecret()}
                      type="button"
                    >
                      {isSavingSecret ? "Saving..." : "Save secret"}
                    </button>
                  </div>
                </div>

                <div className="space-y-3">
                  {isLoadingSecrets ? (
                    <div className="rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4 text-sm text-muted">
                      Loading secret previews...
                    </div>
                  ) : secrets.length === 0 ? (
                    <div className="rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4 text-sm text-muted">
                      No workspace secrets yet.
                    </div>
                  ) : (
                    secrets.map((secret) => (
                      <div
                        className="flex flex-wrap items-center justify-between gap-3 rounded-[1.4rem] border border-border/70 bg-surface-strong/65 p-4"
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
                          className="rounded-full border border-rose-400/55 bg-rose-500/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.16em] text-rose-900 transition hover:bg-rose-500/14"
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
              <div className="rounded-[1.5rem] border border-border/70 bg-surface-strong/65 p-5 text-sm leading-7 text-muted">
                Workspace admins can manage encrypted secret previews from this surface.
              </div>
            )}
          </div>
        </Section>
      </div>
    </div>
  );
}
