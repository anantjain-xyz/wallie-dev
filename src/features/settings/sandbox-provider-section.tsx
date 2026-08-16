"use client";

import { useMemo, useState, type ReactNode } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { Status } from "@/components/ui/status";
import type { SettingsPageData } from "@/features/settings/data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { Section } from "@/features/settings/settings-ui";
import type {
  DaytonaSandboxConnectionPreview,
  E2BSandboxConnectionPreview,
  SandboxConnectionPreviews,
  SandboxSettingsResponse,
} from "@/lib/sandbox-connections/contracts";
import type { SandboxProvider } from "@/lib/sandbox";
import type { VercelSandboxConnectionPreview } from "@/lib/vercel-sandbox/contracts";

const connectionUpdatedAtFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  timeZone: "UTC",
  year: "numeric",
});

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
  const [selectedProvider, setSelectedProvider] = useState<SandboxProvider | null>(() => {
    if (variant === "onboarding") {
      return settings.connections[settings.activeProvider] ? settings.activeProvider : null;
    }

    return settings.enabledProviders.includes(settings.activeProvider)
      ? settings.activeProvider
      : (settings.enabledProviders[0] ?? null);
  });
  const [replacingProvider, setReplacingProvider] = useState<SandboxProvider | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [disconnectProvider, setDisconnectProvider] = useState<SandboxProvider | null>(null);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  async function request<T>(url: string, init: RequestInit): Promise<T> {
    const response = await fetch(url, {
      ...init,
      headers: { "Content-Type": "application/json", ...init.headers },
    });
    const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!response.ok) throw new Error(body?.error ?? "Sandbox provider request failed.");
    return body as T;
  }

  function clearSecretDraft(provider: SandboxProvider) {
    if (provider === "vercel") setVercelToken("");
    else setApiKeys((current) => ({ ...current, [provider]: "" }));
  }

  function restoreNonSecretFields(provider: SandboxProvider) {
    if (provider === "vercel") {
      setVercelTeamId(settings.connections.vercel?.teamId ?? "");
      setVercelProjectId(settings.connections.vercel?.projectId ?? "");
      return;
    }
    if (provider === "daytona") {
      setDaytonaApiUrl(settings.connections.daytona?.apiUrl ?? "");
      setDaytonaTarget(settings.connections.daytona?.target ?? "");
    }
  }

  function startReplace(provider: SandboxProvider) {
    restoreNonSecretFields(provider);
    clearSecretDraft(provider);
    setReplacingProvider(provider);
  }

  function cancelReplace(provider: SandboxProvider) {
    clearSecretDraft(provider);
    restoreNonSecretFields(provider);
    setReplacingProvider(null);
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
      clearSecretDraft(provider);
      setReplacingProvider(null);
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
    setDisconnectError(null);
    try {
      await request<{ connection: null }>(
        `/api/workspaces/${workspaceId}/sandbox-connections/${provider}`,
        { method: "DELETE" },
      );
      onSettingsChange({
        ...settings,
        connections: { ...settings.connections, [provider]: null },
      });
      setReplacingProvider((current) => (current === provider ? null : current));
      setDisconnectProvider(null);
      setFlashMessage({ kind: "success", text: `${providerLabel(provider)} disconnected.` });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Sandbox disconnect failed.";
      setDisconnectError(message);
      setFlashMessage({
        kind: "error",
        text: message,
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

  function selectProvider(provider: SandboxProvider) {
    if (selectedProvider) clearSecretDraft(selectedProvider);
    setSelectedProvider(provider);
    setReplacingProvider(null);
    setDisconnectProvider(null);
    setDisconnectError(null);
  }

  function providerForm(provider: SandboxProvider, cancellable: boolean) {
    const onCancel = cancellable ? () => cancelReplace(provider) : undefined;
    return provider === "vercel" ? (
      <ProviderForm title="Vercel Sandbox">
        <SecretInput label="Token" onChange={setVercelToken} value={vercelToken} />
        <TextInput label="Team id" onChange={setVercelTeamId} value={vercelTeamId} />
        <TextInput label="Project id" onChange={setVercelProjectId} value={vercelProjectId} />
        <FormActions
          disabled={pending !== null}
          onCancel={onCancel}
          onSave={() => void save("vercel")}
        />
      </ProviderForm>
    ) : provider === "e2b" ? (
      <ProviderForm title="E2B">
        <SecretInput
          label="API key"
          onChange={(value) => setApiKeys((current) => ({ ...current, e2b: value }))}
          value={apiKeys.e2b}
        />
        <FormActions
          disabled={pending !== null}
          onCancel={onCancel}
          onSave={() => void save("e2b")}
        />
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
        <FormActions
          disabled={pending !== null}
          onCancel={onCancel}
          onSave={() => void save("daytona")}
        />
      </ProviderForm>
    );
  }

  const selectedStatus = selectedProvider ? connectionStatus(selectedProvider) : null;
  const selectedConfigured = Boolean(selectedStatus?.connection);
  const selectedReplacing =
    selectedConfigured && selectedProvider !== null && replacingProvider === selectedProvider;

  return (
    <Section
      anchorId="sandbox"
      tagline="Choose where Wallie executes agents. Connections are retained when you switch; jobs never fall back to another provider."
      title="Sandbox"
    >
      <div className="space-y-5">
        <div className="space-y-6">
          <fieldset>
            <legend className="text-[13px] font-semibold text-foreground">Choose a provider</legend>
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
                      onChange={() => selectProvider(provider.id)}
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

          {selectedProvider && selectedStatus ? (
            <div className="w-full space-y-3">
              {selectedStatus.connection?.lastValidationError ? (
                <p className="text-xs text-danger">
                  {selectedStatus.connection.lastValidationError}
                </p>
              ) : null}
              {selectedConfigured && !selectedReplacing ? (
                <SavedConnectionSummary
                  canManage={canManage}
                  disabled={pending !== null}
                  disconnectError={disconnectError}
                  disconnectOpen={disconnectProvider === selectedProvider}
                  disconnectPending={pending === `delete:${selectedProvider}`}
                  onActivate={() => void activate(selectedProvider)}
                  onDisconnect={() => void disconnect(selectedProvider)}
                  onDisconnectOpenChange={(open) => {
                    setDisconnectError(null);
                    setDisconnectProvider(open ? selectedProvider : null);
                  }}
                  onReplace={() => startReplace(selectedProvider)}
                  provider={selectedProvider}
                  activeProvider={settings.activeProvider}
                  status={selectedStatus}
                />
              ) : (
                <>
                  <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
                    <div className="min-w-0">
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
                      disconnectError={disconnectError}
                      disconnectOpen={disconnectProvider === selectedProvider}
                      disconnectPending={pending === `delete:${selectedProvider}`}
                      onDisconnectOpenChange={(open) => {
                        setDisconnectError(null);
                        setDisconnectProvider(open ? selectedProvider : null);
                      }}
                      onActivate={() => void activate(selectedProvider)}
                      onDisconnect={() => void disconnect(selectedProvider)}
                      provider={selectedProvider}
                      activeProvider={settings.activeProvider}
                      status={selectedStatus}
                    />
                  </div>
                  <ProviderDisconnectGuidance
                    visible={selectedStatus.active && Boolean(selectedStatus.connection)}
                  />
                  {canManage ? providerForm(selectedProvider, selectedReplacing) : null}
                </>
              )}
            </div>
          ) : (
            <div className="rounded-[6px] border border-dashed border-border bg-sheet px-4 py-5 text-[13px] text-muted">
              Select a provider to continue with its connection details.
            </div>
          )}
        </div>
      </div>
    </Section>
  );
}

function SavedConnectionSummary({
  activeProvider,
  canManage,
  disabled,
  disconnectError,
  disconnectOpen,
  disconnectPending,
  onActivate,
  onDisconnect,
  onDisconnectOpenChange,
  onReplace,
  provider,
  status,
}: {
  activeProvider: SandboxProvider;
  canManage: boolean;
  disabled: boolean;
  disconnectError: string | null;
  disconnectOpen: boolean;
  disconnectPending: boolean;
  onActivate: () => void;
  onDisconnect: () => void;
  onDisconnectOpenChange: (open: boolean) => void;
  onReplace: () => void;
  provider: SandboxProvider;
  status: {
    active: boolean;
    connected: boolean;
    connection: SandboxConnectionPreviews[SandboxProvider];
  };
}) {
  const connection = status.connection;
  if (!connection) return null;

  return (
    <div className="space-y-3 rounded-[6px] border border-border bg-sheet p-4">
      <div className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h3 className="text-[13px] font-semibold text-foreground">
            {providerLabel(provider)} {status.connected ? "connected" : "saved"}
          </h3>
          <p className="font-mono text-xs text-muted">{secretPreview(provider, connection)}</p>
          <p className="text-xs text-muted">
            Updated {connectionUpdatedAtFormatter.format(new Date(connection.updatedAt))}
          </p>
        </div>
        <ProviderActions
          activeProvider={activeProvider}
          canManage={canManage}
          disabled={disabled}
          disconnectError={disconnectError}
          disconnectOpen={disconnectOpen}
          disconnectPending={disconnectPending}
          onActivate={onActivate}
          onDisconnect={onDisconnect}
          onDisconnectOpenChange={onDisconnectOpenChange}
          onReplace={canManage ? onReplace : undefined}
          provider={provider}
          status={status}
        />
      </div>
      <ProviderDisconnectGuidance visible={status.active && Boolean(status.connection)} />
      <ConnectionMetadata connection={connection} provider={provider} />
    </div>
  );
}

function ConnectionMetadata({
  connection,
  provider,
}: {
  connection: NonNullable<SandboxConnectionPreviews[SandboxProvider]>;
  provider: SandboxProvider;
}) {
  if (provider === "vercel") {
    const vercel = connection as VercelSandboxConnectionPreview;
    return (
      <dl className="grid gap-1 text-xs">
        <MetadataRow label="Team ID" value={vercel.teamId} />
        <MetadataRow label="Project ID" value={vercel.projectId} />
      </dl>
    );
  }
  if (provider === "daytona") {
    const daytona = connection as DaytonaSandboxConnectionPreview;
    const rows = [
      daytona.apiUrl ? { label: "API URL", value: daytona.apiUrl } : null,
      daytona.target ? { label: "Target", value: daytona.target } : null,
    ].filter((row): row is { label: string; value: string } => row !== null);
    if (rows.length === 0) return null;
    return (
      <dl className="grid gap-1 text-xs">
        {rows.map((row) => (
          <MetadataRow key={row.label} label={row.label} value={row.value} />
        ))}
      </dl>
    );
  }
  return null;
}

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted">{label}</dt>
      <dd className="font-mono text-foreground">{value}</dd>
    </div>
  );
}

function ProviderActions({
  activeProvider,
  canManage,
  disabled,
  disconnectError,
  disconnectOpen,
  disconnectPending,
  onActivate,
  onDisconnect,
  onDisconnectOpenChange,
  onReplace,
  provider,
  status,
}: {
  activeProvider: SandboxProvider;
  canManage: boolean;
  disabled: boolean;
  disconnectError: string | null;
  disconnectOpen: boolean;
  disconnectPending: boolean;
  onActivate: () => void;
  onDisconnect: () => void;
  onDisconnectOpenChange: (open: boolean) => void;
  onReplace?: () => void;
  provider: SandboxProvider;
  status: {
    active: boolean;
    connected: boolean;
    connection: SandboxConnectionPreviews[SandboxProvider];
  };
}) {
  return (
    <div className="flex flex-wrap gap-2 sm:justify-end">
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
        <DestructiveConfirmationDialog
          actionLabel={`Disconnect ${providerLabel(provider)}`}
          description={`Disconnecting ${providerLabel(provider)} removes its saved connection from this workspace. Wallie will continue using ${providerLabel(activeProvider)}.`}
          errorMessage={disconnectError}
          onConfirm={onDisconnect}
          onOpenChange={onDisconnectOpenChange}
          open={disconnectOpen}
          pending={disconnectPending}
          pendingLabel="Disconnecting…"
          title={`Disconnect ${providerLabel(provider)}?`}
          trigger={
            <button
              aria-label={`Disconnect ${providerLabel(provider)}`}
              className="ui-button-danger"
              disabled={disabled}
              type="button"
            >
              Disconnect
            </button>
          }
        />
      ) : null}
      {status.active && status.connected ? (
        <a className="ui-button" href="#verify">
          Test capabilities
        </a>
      ) : null}
      {onReplace ? (
        <button className="ui-button" disabled={disabled} onClick={onReplace} type="button">
          Replace connection
        </button>
      ) : null}
    </div>
  );
}

function ProviderDisconnectGuidance({ visible }: { visible: boolean }) {
  if (!visible) return null;

  return (
    <p className="text-xs leading-5 text-muted">
      Switch to another connected provider before disconnecting this one.
    </p>
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

function FormActions({
  disabled,
  onCancel,
  onSave,
}: {
  disabled: boolean;
  onCancel?: () => void;
  onSave: () => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      <button className="ui-button-primary" disabled={disabled} onClick={onSave} type="button">
        Save connection
      </button>
      {onCancel ? (
        <button className="ui-button" disabled={disabled} onClick={onCancel} type="button">
          Cancel
        </button>
      ) : null}
    </div>
  );
}

function secretPreview(
  provider: SandboxProvider,
  connection: NonNullable<SandboxConnectionPreviews[SandboxProvider]>,
) {
  const preview =
    provider === "vercel"
      ? (connection as VercelSandboxConnectionPreview).tokenPreview
      : (connection as E2BSandboxConnectionPreview).apiKeyPreview;
  return displaySecretPreview(preview);
}

function displaySecretPreview(preview: string | null) {
  if (!preview) return "preview unavailable";
  // `buildSecretPreview` only returns the complete secret when length <= 6.
  if (preview.length <= 6) return "••••";
  return preview;
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
