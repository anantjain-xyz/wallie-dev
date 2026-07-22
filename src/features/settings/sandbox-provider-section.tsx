"use client";

import { useMemo, useState, type ReactNode } from "react";

import { Status, configurationStatusFromTone } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import type {
  SandboxConnectionPreviews,
  SandboxSettingsResponse,
} from "@/lib/sandbox-connections/contracts";
import type { SandboxProvider } from "@/lib/sandbox";

const PROVIDERS: Array<{ description: string; id: SandboxProvider; label: string }> = [
  {
    description: "Vercel-managed microVMs connected to a team and project.",
    id: "vercel",
    label: "Vercel Sandbox",
  },
  {
    description: "E2B managed sandboxes using the standard base template.",
    id: "e2b",
    label: "E2B",
  },
  {
    description: "Daytona Cloud or an approved self-hosted control plane.",
    id: "daytona",
    label: "Daytona",
  },
];

type Props = {
  canManage: boolean;
  onSettingsChange: (settings: SandboxSettingsResponse) => void;
  setFlashMessage: (message: FlashMessage) => void;
  settings?: SandboxSettingsResponse;
  variant?: "onboarding" | "settings";
  vercelConnection: SettingsPageData["vercelSandboxConnection"];
  workspaceId: string;
};

export function SandboxProviderSection({
  canManage,
  onSettingsChange,
  setFlashMessage,
  settings: suppliedSettings,
  variant = "settings",
  vercelConnection,
  workspaceId,
}: Props) {
  const settings = useMemo(
    () => suppliedSettings ?? legacySettings(vercelConnection),
    [suppliedSettings, vercelConnection],
  );
  const [apiKeys, setApiKeys] = useState<Record<"daytona" | "e2b", string>>({
    daytona: "",
    e2b: "",
  });
  const [vercelToken, setVercelToken] = useState("");
  const [vercelTeamId, setVercelTeamId] = useState(vercelConnection?.teamId ?? "");
  const [vercelProjectId, setVercelProjectId] = useState(vercelConnection?.projectId ?? "");
  const [daytonaApiUrl, setDaytonaApiUrl] = useState(settings.connections.daytona?.apiUrl ?? "");
  const [daytonaTarget, setDaytonaTarget] = useState(settings.connections.daytona?.target ?? "");
  const [selectedProvider, setSelectedProvider] = useState<SandboxProvider | null>(() =>
    variant === "onboarding" && settings.connections[settings.activeProvider]
      ? settings.activeProvider
      : null,
  );
  const [pending, setPending] = useState<string | null>(null);

  async function request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) throw new Error(body?.error ?? "Sandbox provider request failed.");
    return body as T;
  }

  async function save(provider: SandboxProvider) {
    const body =
      provider === "vercel"
        ? { projectId: vercelProjectId, teamId: vercelTeamId, token: vercelToken }
        : provider === "e2b"
          ? { apiKey: apiKeys.e2b }
          : {
              apiKey: apiKeys.daytona,
              apiUrl: daytonaApiUrl || undefined,
              target: daytonaTarget || undefined,
            };
    if (Object.values(body).some((value) => typeof value === "string" && !value.trim())) {
      setFlashMessage({ kind: "error", text: `Complete the ${providerLabel(provider)} fields.` });
      return;
    }
    setPending(`save:${provider}`);
    try {
      const result = await request<{ connection: SandboxConnectionPreviews[SandboxProvider] }>(
        `/api/workspaces/${workspaceId}/sandbox-connections/${provider}`,
        { body: JSON.stringify(body), method: "PUT" },
      );
      onSettingsChange({
        ...settings,
        connections: { ...settings.connections, [provider]: result.connection },
      });
      if (provider === "vercel") setVercelToken("");
      else setApiKeys((current) => ({ ...current, [provider]: "" }));
      setFlashMessage({ kind: "success", text: `${providerLabel(provider)} connection saved.` });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Sandbox connection failed.",
      });
    } finally {
      setPending(null);
    }
  }

  async function disconnect(provider: SandboxProvider) {
    setPending(`delete:${provider}`);
    try {
      await request<{ connection: null }>(
        `/api/workspaces/${workspaceId}/sandbox-connections/${provider}`,
        { method: "DELETE" },
      );
      onSettingsChange({
        ...settings,
        connections: { ...settings.connections, [provider]: null },
      });
      setFlashMessage({ kind: "success", text: `${providerLabel(provider)} disconnected.` });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Sandbox disconnect failed.",
      });
    } finally {
      setPending(null);
    }
  }

  async function activate(provider: SandboxProvider) {
    setPending(`activate:${provider}`);
    try {
      const result = await request<SandboxSettingsResponse>(
        `/api/workspaces/${workspaceId}/sandbox-settings`,
        {
          body: JSON.stringify({ activeProvider: provider, expectedRevision: settings.revision }),
          method: "PATCH",
        },
      );
      onSettingsChange(result);
      setFlashMessage({ kind: "success", text: `${providerLabel(provider)} is now active.` });
    } catch (error) {
      setFlashMessage({
        kind: "error",
        text: error instanceof Error ? error.message : "Sandbox provider switch failed.",
      });
    } finally {
      setPending(null);
    }
  }

  const enabledProviders = PROVIDERS.filter((provider) =>
    settings.enabledProviders.includes(provider.id),
  );

  function connectionStatus(provider: SandboxProvider) {
    const connection = settings.connections[provider];
    const active = settings.activeProvider === provider;
    const connected = connection?.status === "connected";
    return {
      active,
      connected,
      connection,
    } as const;
  }

  function providerForm(provider: SandboxProvider) {
    return provider === "vercel" ? (
      <ProviderForm title="Vercel Sandbox">
        <SecretInput label="Token" onChange={setVercelToken} value={vercelToken} />
        <TextInput label="Team id" onChange={setVercelTeamId} value={vercelTeamId} />
        <TextInput label="Project id" onChange={setVercelProjectId} value={vercelProjectId} />
        <SaveButton disabled={pending !== null} onClick={() => void save("vercel")} />
      </ProviderForm>
    ) : provider === "e2b" ? (
      <ProviderForm title="E2B">
        <SecretInput
          label="API key"
          onChange={(value) => setApiKeys((current) => ({ ...current, e2b: value }))}
          value={apiKeys.e2b}
        />
        <SaveButton disabled={pending !== null} onClick={() => void save("e2b")} />
      </ProviderForm>
    ) : (
      <ProviderForm title="Daytona">
        <SecretInput
          label="API key"
          onChange={(value) => setApiKeys((current) => ({ ...current, daytona: value }))}
          value={apiKeys.daytona}
        />
        <TextInput label="API URL (optional)" onChange={setDaytonaApiUrl} value={daytonaApiUrl} />
        <TextInput label="Target (optional)" onChange={setDaytonaTarget} value={daytonaTarget} />
        <SaveButton disabled={pending !== null} onClick={() => void save("daytona")} />
      </ProviderForm>
    );
  }

  return (
    <Section
      anchorId="sandbox"
      tagline="Choose where Wallie executes agents. Connections are retained when you switch; jobs never fall back to another provider."
      title="Sandbox provider"
    >
      <div className="space-y-5">
        {variant === "onboarding" ? (
          <div className="space-y-6">
            <fieldset>
              <legend className="text-[13px] font-semibold text-foreground">
                Choose a provider
              </legend>
              <p className="mt-1 text-xs leading-5 text-muted">
                Select where Wallie should run agents. You’ll configure only that provider next.
              </p>
              <div className="mt-3 grid gap-3 md:grid-cols-3">
                {enabledProviders.map((provider) => {
                  const status = connectionStatus(provider.id);
                  return (
                    <label className="block cursor-pointer" key={provider.id}>
                      <input
                        checked={selectedProvider === provider.id}
                        className="peer sr-only"
                        name="sandbox-provider"
                        onChange={() => setSelectedProvider(provider.id)}
                        type="radio"
                        value={provider.id}
                      />
                      <span
                        className={`block h-full rounded-[6px] border p-4 transition-colors peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent ${
                          selectedProvider === provider.id
                            ? "border-accent bg-accent-soft"
                            : "border-border bg-sheet hover:border-muted"
                        }`}
                      >
                        <span className="flex items-center justify-between gap-2">
                          <span className="text-[13px] font-semibold text-foreground">
                            {provider.label}
                          </span>
                          {status.active ? <Status label="Active" value="healthy" /> : null}
                        </span>
                        <span className="mt-2 block text-xs leading-5 text-muted">
                          {provider.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            {selectedProvider ? (
              <div className="max-w-2xl space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h3 className="text-[13px] font-semibold text-foreground">
                      Configure {providerLabel(selectedProvider)}
                    </h3>
                    <p className="mt-1 text-xs text-muted">
                      Enter the connection details for the provider you selected.
                    </p>
                  </div>
                  <ProviderActions
                    canManage={canManage}
                    disabled={pending !== null}
                    onActivate={() => void activate(selectedProvider)}
                    onDisconnect={() => void disconnect(selectedProvider)}
                    status={connectionStatus(selectedProvider)}
                  />
                </div>
                {connectionStatus(selectedProvider).connection?.lastValidationError ? (
                  <p className="text-xs text-danger">
                    {connectionStatus(selectedProvider).connection?.lastValidationError}
                  </p>
                ) : null}
                {canManage ? providerForm(selectedProvider) : null}
              </div>
            ) : (
              <div className="rounded-[6px] border border-dashed border-border bg-sheet px-4 py-5 text-[13px] text-muted">
                Select a provider to continue with its connection details.
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="grid gap-3 lg:grid-cols-3">
              {enabledProviders.map((provider) => {
                const connection = settings.connections[provider.id];
                const active = settings.activeProvider === provider.id;
                const connected = connection?.status === "connected";
                return (
                  <article
                    className={`rounded-[6px] border p-4 ${active ? "border-accent bg-accent-soft" : "border-border bg-sheet"}`}
                    key={provider.id}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="text-[13px] font-semibold text-foreground">
                        {provider.label}
                      </h3>
                      <Status
                        label={
                          active && connected
                            ? "Active"
                            : connection
                              ? "Needs attention"
                              : "Missing"
                        }
                        value={configurationStatusFromTone(
                          active && connected ? "success" : connection ? "danger" : "warning",
                        )}
                      />
                    </div>
                    <p className="mt-2 text-xs leading-5 text-muted">{provider.description}</p>
                    {connection?.lastValidationError ? (
                      <p className="mt-2 text-xs text-danger">{connection.lastValidationError}</p>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      {canManage && connected && !active ? (
                        <button
                          className="ui-button-primary"
                          disabled={pending !== null}
                          onClick={() => void activate(provider.id)}
                          type="button"
                        >
                          Use this provider
                        </button>
                      ) : null}
                      {connection && canManage && !active ? (
                        <button
                          className="ui-button-danger"
                          disabled={pending !== null}
                          onClick={() => void disconnect(provider.id)}
                          type="button"
                        >
                          Disconnect
                        </button>
                      ) : null}
                      {active && connected ? (
                        <a className="ui-button" href="#verify">
                          Test capabilities
                        </a>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>

            {canManage ? (
              <div className="grid gap-5 lg:grid-cols-3">
                {enabledProviders.map((provider) => (
                  <div key={provider.id}>{providerForm(provider.id)}</div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] leading-6 text-muted">
                Workspace admins can connect and select sandbox providers.
              </p>
            )}
          </>
        )}
      </div>
    </Section>
  );
}

function ProviderActions({
  canManage,
  disabled,
  onActivate,
  onDisconnect,
  status,
}: {
  canManage: boolean;
  disabled: boolean;
  onActivate: () => void;
  onDisconnect: () => void;
  status: {
    active: boolean;
    connected: boolean;
    connection: SandboxConnectionPreviews[SandboxProvider];
  };
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {canManage && status.connected && !status.active ? (
        <button
          className="ui-button-primary"
          disabled={disabled}
          onClick={onActivate}
          type="button"
        >
          Use this provider
        </button>
      ) : null}
      {canManage && status.connection && !status.active ? (
        <button
          className="ui-button-danger"
          disabled={disabled}
          onClick={onDisconnect}
          type="button"
        >
          Disconnect
        </button>
      ) : null}
      {status.active && status.connected ? (
        <a className="ui-button" href="#verify">
          Test capabilities
        </a>
      ) : null}
    </div>
  );
}

function ProviderForm({ children, title }: { children: ReactNode; title: string }) {
  return (
    <div className="space-y-3 rounded-[6px] border border-border bg-sheet p-4">
      <h3 className="text-[13px] font-semibold text-foreground">Connect {title}</h3>
      {children}
    </div>
  );
}

function TextInput({
  label,
  onChange,
  type = "text",
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  type?: "password" | "text";
  value: string;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-xs font-medium text-foreground">{label}</span>
      <input
        autoComplete="off"
        className="ui-input"
        onChange={(event) => onChange(event.target.value)}
        spellCheck={false}
        type={type}
        value={value}
      />
    </label>
  );
}

function SecretInput(props: Parameters<typeof TextInput>[0]) {
  return <TextInput {...props} type="password" />;
}

function SaveButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button className="ui-button-primary" disabled={disabled} onClick={onClick} type="button">
      Save connection
    </button>
  );
}

function providerLabel(provider: SandboxProvider) {
  return PROVIDERS.find((candidate) => candidate.id === provider)?.label ?? provider;
}

function legacySettings(
  vercel: SettingsPageData["vercelSandboxConnection"],
): SandboxSettingsResponse {
  return {
    activeProvider: "vercel",
    connections: { daytona: null, e2b: null, vercel },
    enabledProviders: ["vercel", "e2b", "daytona"],
    revision: 1,
    updatedAt: null,
  };
}

export function applySandboxSettingsToData(
  current: SettingsPageData,
  settings: SandboxSettingsResponse,
): SettingsPageData {
  const active = settings.connections[settings.activeProvider];
  const vercel = settings.connections.vercel;
  const activeProviderEnabled = settings.enabledProviders.includes(settings.activeProvider);
  const activeProviderDisabledError = `${providerLabel(settings.activeProvider)} is disabled in this Wallie deployment. Switch to an enabled sandbox provider.`;
  return {
    ...current,
    sandboxSettings: settings,
    setupHealth: {
      ...current.setupHealth,
      sandboxConnection: {
        connected: activeProviderEnabled && active?.status === "connected",
        connectionRevision: active ? String(active.connectionRevision) : null,
        displayName:
          settings.activeProvider === "vercel"
            ? (vercel?.projectName ?? vercel?.projectId ?? null)
            : settings.activeProvider === "e2b"
              ? (settings.connections.e2b?.apiKeyPreview ?? null)
              : (settings.connections.daytona?.target ??
                settings.connections.daytona?.apiUrl ??
                null),
        lastValidationError: activeProviderEnabled
          ? (active?.lastValidationError ?? null)
          : activeProviderDisabledError,
        provider: settings.activeProvider,
        providerLabel: providerLabel(settings.activeProvider),
        status: activeProviderEnabled ? (active?.status ?? "missing") : "error",
        updatedAt: active?.updatedAt ?? null,
      },
      vercelSandboxConnection: vercel
        ? {
            connected: vercel.status === "connected",
            lastValidationError: vercel.lastValidationError,
            projectId: vercel.projectId,
            projectName: vercel.projectName,
            status: vercel.status,
            teamId: vercel.teamId,
            updatedAt: vercel.updatedAt,
          }
        : {
            connected: false,
            lastValidationError: null,
            projectId: null,
            projectName: null,
            status: "missing",
            teamId: null,
            updatedAt: null,
          },
    },
    vercelSandboxConnection: vercel,
  };
}
