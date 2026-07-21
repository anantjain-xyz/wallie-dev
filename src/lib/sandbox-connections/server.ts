import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import {
  SANDBOX_PROVIDERS,
  type DaytonaSandboxConnectionPreview,
  type E2BSandboxConnectionPreview,
  type SandboxConnectionPreviews,
  type SandboxConnectionStatus,
  type SandboxSettingsResponse,
} from "./contracts";
import { buildSecretPreview, decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import {
  listRunningSandboxes,
  stopSandboxById,
  validateSandboxConnection,
  type DaytonaSandboxCredentials,
  type E2BSandboxCredentials,
  type SandboxConnection,
  type SandboxProvider,
} from "@/lib/sandbox";
import type { Database, Tables } from "@/lib/supabase/database.types";
import {
  loadConnectedVercelSandboxConnections,
  loadVercelSandboxConnection,
  loadVercelSandboxConnectionPreview,
} from "@/lib/vercel-sandbox/server";

type AdminClient = SupabaseClient<Database>;
type E2BRow = Tables<"workspace_e2b_sandbox_connections">;
type DaytonaRow = Tables<"workspace_daytona_sandbox_connections">;

const DAYTONA_CLOUD_API_URL = "https://app.daytona.io/api";
const e2bPreviewSelect =
  "workspace_id, api_key_preview, status, connection_revision, last_validated_at, last_validation_error, updated_at";
const e2bSecretSelect = `${e2bPreviewSelect}, encrypted_api_key`;
const daytonaPreviewSelect = `${e2bPreviewSelect}, api_url, target`;
const daytonaSecretSelect = `${daytonaPreviewSelect}, encrypted_api_key`;

export class SandboxConnectionMissingError extends Error {
  readonly provider: SandboxProvider;
  constructor(provider: SandboxProvider) {
    super(`Connect ${providerLabel(provider)} before starting Wallie runs.`);
    this.name = "SandboxConnectionMissingError";
    this.provider = provider;
  }
}

export class SandboxConnectionInvalidError extends Error {
  readonly provider: SandboxProvider;
  constructor(provider: SandboxProvider, message?: string | null) {
    super(message || `The saved ${providerLabel(provider)} connection is invalid. Reconnect it.`);
    this.name = "SandboxConnectionInvalidError";
    this.provider = provider;
  }
}

export class SandboxConnectionMutationInProgressError extends Error {
  constructor() {
    super("Sandbox connection update is already in progress. Try again shortly.");
    this.name = "SandboxConnectionMutationInProgressError";
  }
}

export class SandboxConnectionActiveWorkError extends Error {
  constructor() {
    super("Cannot change this sandbox connection while related Wallie work is active.");
    this.name = "SandboxConnectionActiveWorkError";
  }
}

export function providerLabel(provider: SandboxProvider): string {
  if (provider === "e2b") return "E2B";
  if (provider === "daytona") return "Daytona";
  return "Vercel Sandbox";
}

export function getEnabledSandboxProviders(): SandboxProvider[] {
  const raw = process.env.WALLIE_ENABLED_SANDBOX_PROVIDERS;
  if (!raw) return [...SANDBOX_PROVIDERS];
  const selected = new Set(raw.split(",").map((value) => value.trim().toLowerCase()));
  return SANDBOX_PROVIDERS.filter((provider) => selected.has(provider));
}

export function normalizeDaytonaApiUrl(value?: string): string {
  const raw = value?.trim() || DAYTONA_CLOUD_API_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Daytona API URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:") throw new Error("Daytona API URL must use HTTPS.");
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Daytona API URL cannot contain credentials, query parameters, or fragments.");
  }
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  const normalized = url.toString().replace(/\/$/, "");
  const allowed = new Set<string>([DAYTONA_CLOUD_API_URL]);
  for (const entry of (process.env.WALLIE_DAYTONA_API_URL_ALLOWLIST ?? "").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const candidate = new URL(trimmed);
      if (candidate.protocol === "https:" && !candidate.username && !candidate.password) {
        candidate.pathname = candidate.pathname.replace(/\/+$/, "") || "/";
        allowed.add(candidate.toString().replace(/\/$/, ""));
      }
    } catch {
      // Invalid operator entries never broaden the allowlist.
    }
  }
  if (!allowed.has(normalized)) {
    throw new Error("Daytona API URL is not allowed by this Wallie deployment.");
  }
  return normalized;
}

export async function loadWorkspaceSandboxSettings(
  admin: AdminClient,
  workspaceId: string,
): Promise<{ activeProvider: SandboxProvider; revision: number; updatedAt: string | null }> {
  const { data, error } = await admin
    .from("workspace_sandbox_settings")
    .select("active_provider, revision, updated_at")
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return {
    activeProvider: normalizeProvider(data?.active_provider),
    revision: Number(data?.revision ?? 1),
    updatedAt: data?.updated_at ?? null,
  };
}

export async function loadWorkspaceSandboxOverview(
  admin: AdminClient,
  workspaceId: string,
): Promise<SandboxSettingsResponse> {
  const [settings, vercel, e2b, daytona] = await Promise.all([
    loadWorkspaceSandboxSettings(admin, workspaceId),
    loadVercelSandboxConnectionPreview(admin, workspaceId),
    loadE2BSandboxConnectionPreview(admin, workspaceId),
    loadDaytonaSandboxConnectionPreview(admin, workspaceId),
  ]);
  return {
    ...settings,
    connections: { daytona, e2b, vercel },
    enabledProviders: getEnabledSandboxProviders(),
  };
}

export async function loadE2BSandboxConnectionPreview(
  admin: AdminClient,
  workspaceId: string,
): Promise<E2BSandboxConnectionPreview | null> {
  const { data, error } = await admin
    .from("workspace_e2b_sandbox_connections")
    .select(e2bPreviewSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapE2BPreview(data as E2BRow) : null;
}

export async function loadDaytonaSandboxConnectionPreview(
  admin: AdminClient,
  workspaceId: string,
): Promise<DaytonaSandboxConnectionPreview | null> {
  const { data, error } = await admin
    .from("workspace_daytona_sandbox_connections")
    .select(daytonaPreviewSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data ? mapDaytonaPreview(data as DaytonaRow) : null;
}

export async function loadWorkspaceSandboxConnection(
  admin: AdminClient,
  workspaceId: string,
  provider: SandboxProvider,
): Promise<{
  connection: SandboxConnection;
  preview: SandboxConnectionPreviews[SandboxProvider];
} | null> {
  if (provider === "vercel") {
    const record = await loadVercelSandboxConnection(admin, workspaceId);
    if (!record) return null;
    return {
      connection: {
        credentials: record.credentials,
        provider,
        revision: record.preview.connectionRevision ?? record.preview.updatedAt,
      },
      preview: record.preview,
    };
  }

  if (provider === "e2b") {
    const { data, error } = await admin
      .from("workspace_e2b_sandbox_connections")
      .select(e2bSecretSelect)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw error;
    if (!data) return null;
    const row = data as E2BRow;
    return {
      connection: {
        credentials: { apiKey: decryptSecretValue(row.encrypted_api_key) },
        provider,
        revision: row.connection_revision,
      },
      preview: mapE2BPreview(row),
    };
  }
  const { data, error } = await admin
    .from("workspace_daytona_sandbox_connections")
    .select(daytonaSecretSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const row = data as DaytonaRow;
  return {
    connection: {
      credentials: {
        apiKey: decryptSecretValue(row.encrypted_api_key),
        apiUrl: normalizeDaytonaApiUrl(row.api_url),
        target: row.target ?? undefined,
      },
      provider,
      revision: row.connection_revision,
    },
    preview: mapDaytonaPreview(row),
  };
}

export async function loadRequiredWorkspaceSandboxConnection(
  admin: AdminClient,
  workspaceId: string,
): Promise<{ connection: SandboxConnection; provider: SandboxProvider }> {
  const settings = await loadWorkspaceSandboxSettings(admin, workspaceId);
  if (!getEnabledSandboxProviders().includes(settings.activeProvider)) {
    throw new SandboxConnectionInvalidError(
      settings.activeProvider,
      `${providerLabel(settings.activeProvider)} is disabled in this Wallie deployment.`,
    );
  }
  const record = await loadWorkspaceSandboxConnection(admin, workspaceId, settings.activeProvider);
  if (!record) throw new SandboxConnectionMissingError(settings.activeProvider);
  if (!record.preview || record.preview.status !== "connected") {
    throw new SandboxConnectionInvalidError(
      settings.activeProvider,
      record.preview?.lastValidationError,
    );
  }
  return { connection: record.connection, provider: settings.activeProvider };
}

export async function loadAllConnectedSandboxConnections(
  admin: AdminClient,
): Promise<Array<{ connection: SandboxConnection; workspaceId: string }>> {
  const [vercel, e2bResult, daytonaResult] = await Promise.all([
    loadConnectedVercelSandboxConnections(admin),
    admin
      .from("workspace_e2b_sandbox_connections")
      .select(e2bSecretSelect)
      .eq("status", "connected"),
    admin
      .from("workspace_daytona_sandbox_connections")
      .select(daytonaSecretSelect)
      .eq("status", "connected"),
  ]);
  if (e2bResult.error) throw e2bResult.error;
  if (daytonaResult.error) throw daytonaResult.error;
  return [
    ...vercel.map((record) => ({
      connection: {
        credentials: record.credentials,
        provider: "vercel" as const,
        revision: record.preview.connectionRevision ?? record.preview.updatedAt,
      },
      workspaceId: record.preview.workspaceId,
    })),
    ...((e2bResult.data ?? []) as E2BRow[]).map((row) => ({
      connection: {
        credentials: { apiKey: decryptSecretValue(row.encrypted_api_key) },
        provider: "e2b" as const,
        revision: row.connection_revision,
      },
      workspaceId: row.workspace_id,
    })),
    ...((daytonaResult.data ?? []) as DaytonaRow[]).map((row) => ({
      connection: {
        credentials: {
          apiKey: decryptSecretValue(row.encrypted_api_key),
          apiUrl: normalizeDaytonaApiUrl(row.api_url),
          target: row.target ?? undefined,
        },
        provider: "daytona" as const,
        revision: row.connection_revision,
      },
      workspaceId: row.workspace_id,
    })),
  ];
}

export async function validateE2BSandboxCredentials(credentials: E2BSandboxCredentials) {
  return validateSandboxConnection({
    credentials,
    provider: "e2b",
    revision: "validation",
  });
}

export async function validateDaytonaSandboxCredentials(credentials: DaytonaSandboxCredentials) {
  const normalized = { ...credentials, apiUrl: normalizeDaytonaApiUrl(credentials.apiUrl) };
  const validation = await validateSandboxConnection({
    credentials: normalized,
    provider: "daytona",
    revision: "validation",
  });
  return { ...validation, credentials: normalized };
}

export async function saveE2BSandboxConnection(input: {
  admin: AdminClient;
  apiKey: string;
  createdByMemberId: string;
  workspaceId: string;
}): Promise<E2BSandboxConnectionPreview> {
  const now = new Date().toISOString();
  const { data, error } = await input.admin
    .from("workspace_e2b_sandbox_connections")
    .upsert(
      {
        api_key_preview: buildSecretPreview(input.apiKey),
        created_by_member_id: input.createdByMemberId,
        encrypted_api_key: encryptSecretValue(input.apiKey),
        last_validated_at: now,
        last_validation_error: null,
        status: "connected",
        workspace_id: input.workspaceId,
      },
      { onConflict: "workspace_id" },
    )
    .select(e2bPreviewSelect)
    .single();
  if (error) throw error;
  return mapE2BPreview(data as E2BRow);
}

export async function saveDaytonaSandboxConnection(input: {
  admin: AdminClient;
  apiKey: string;
  apiUrl: string;
  createdByMemberId: string;
  target?: string;
  workspaceId: string;
}): Promise<DaytonaSandboxConnectionPreview> {
  const now = new Date().toISOString();
  const { data, error } = await input.admin
    .from("workspace_daytona_sandbox_connections")
    .upsert(
      {
        api_key_preview: buildSecretPreview(input.apiKey),
        api_url: normalizeDaytonaApiUrl(input.apiUrl),
        created_by_member_id: input.createdByMemberId,
        encrypted_api_key: encryptSecretValue(input.apiKey),
        last_validated_at: now,
        last_validation_error: null,
        status: "connected",
        target: input.target ?? null,
        workspace_id: input.workspaceId,
      },
      { onConflict: "workspace_id" },
    )
    .select(daytonaPreviewSelect)
    .single();
  if (error) throw error;
  return mapDaytonaPreview(data as DaytonaRow);
}

export async function acquireSandboxConnectionMutationLock(
  admin: AdminClient,
  workspaceId: string,
  provider: SandboxProvider,
): Promise<() => Promise<void>> {
  const { data, error } = await admin.rpc("begin_sandbox_connection_mutation", {
    target_provider: provider,
    target_workspace_id: workspaceId,
  });
  if (error) throw error;
  if (data === "locked") throw new SandboxConnectionMutationInProgressError();
  if (data === "active") throw new SandboxConnectionActiveWorkError();
  if (typeof data !== "string" || !data) throw new Error("Failed to lock sandbox connection.");
  return async () => {
    const { error: releaseError } = await admin
      .from("workspace_sandbox_connection_mutations")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("provider", provider)
      .eq("lock_id", data);
    if (releaseError) throw releaseError;
  };
}

export async function setActiveSandboxProvider(input: {
  admin: AdminClient;
  expectedRevision: number;
  memberId: string;
  provider: SandboxProvider;
  workspaceId: string;
}): Promise<void> {
  if (!getEnabledSandboxProviders().includes(input.provider)) {
    throw new Error(`${providerLabel(input.provider)} is disabled in this deployment.`);
  }
  const { data, error } = await input.admin.rpc("set_active_sandbox_provider", {
    actor_member_id: input.memberId,
    expected_revision: input.expectedRevision,
    target_provider: input.provider,
    target_workspace_id: input.workspaceId,
  });
  if (error) throw error;
  if (data === "updated") return;
  if (data === "active") throw new SandboxConnectionActiveWorkError();
  if (data === "locked") throw new SandboxConnectionMutationInProgressError();
  if (data === "missing") throw new SandboxConnectionMissingError(input.provider);
  if (data === "invalid") throw new SandboxConnectionInvalidError(input.provider);
  if (data === "stale") throw new Error("Sandbox provider setting changed. Refresh and try again.");
  throw new Error("Could not update the sandbox provider.");
}

export async function stopWorkspaceOwnedSandboxes(input: {
  admin: AdminClient;
  connection: SandboxConnection;
  workspaceId: string;
}): Promise<void> {
  const sandboxes = await listRunningSandboxes({
    connection: input.connection,
    throwOnError: true,
    workspaceId: input.workspaceId,
  });
  if (sandboxes.length === 0) return;
  const ids = sandboxes.map((sandbox) => sandbox.id);
  const [runs, checks] = await Promise.all([
    input.admin
      .from("agent_runs")
      .select("sandbox_id")
      .eq("workspace_id", input.workspaceId)
      .eq("sandbox_provider", input.connection.provider)
      .eq("sandbox_connection_revision", input.connection.revision)
      .in("sandbox_id", ids),
    input.admin
      .from("sandbox_capability_checks")
      .select("sandbox_id")
      .eq("workspace_id", input.workspaceId)
      .eq("sandbox_provider", input.connection.provider)
      .eq("sandbox_connection_revision", input.connection.revision)
      .in("sandbox_id", ids),
  ]);
  if (runs.error) throw runs.error;
  if (checks.error) throw checks.error;
  const owned = new Set(
    [...(runs.data ?? []), ...(checks.data ?? [])]
      .map((row) => row.sandbox_id)
      .filter((id): id is string => Boolean(id)),
  );
  for (const sandbox of sandboxes) {
    if (!owned.has(sandbox.id)) continue;
    await stopSandboxById(sandbox.id, {
      connection: input.connection,
      throwOnError: true,
    });
  }
}

function mapE2BPreview(row: E2BRow): E2BSandboxConnectionPreview {
  return {
    apiKeyPreview: row.api_key_preview,
    connectionRevision: row.connection_revision,
    lastValidatedAt: row.last_validated_at,
    lastValidationError: row.last_validation_error,
    status: normalizeStatus(row.status),
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

function mapDaytonaPreview(row: DaytonaRow): DaytonaSandboxConnectionPreview {
  return {
    ...mapE2BPreview(row),
    apiUrl: row.api_url,
    target: row.target,
  };
}

function normalizeStatus(value: string): SandboxConnectionStatus {
  return value === "connected" ? "connected" : "error";
}

function normalizeProvider(value: string | null | undefined): SandboxProvider {
  return value === "e2b" || value === "daytona" ? value : "vercel";
}
