import "server-only";

import { Sandbox } from "@vercel/sandbox";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  type VercelSandboxConnectionPreview,
  type VercelSandboxConnectionStatus,
  type VercelSandboxCredentials,
} from "@/lib/vercel-sandbox/contracts";
import { redactSecrets } from "@/lib/sandbox/command";
import { buildSecretPreview, decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database, Tables } from "@/lib/supabase/database.types";

type AdminClient = SupabaseClient<Database>;
type ConnectionRow = Tables<"workspace_vercel_sandbox_connections">;

const previewSelect =
  "workspace_id, token_preview, team_id, project_id, project_name, status, connection_revision, last_validated_at, last_validation_error, updated_at";
const secretSelect = `${previewSelect}, encrypted_token`;

export class VercelSandboxConnectionMissingError extends Error {
  constructor() {
    super("Connect a Vercel Sandbox account before starting Wallie runs.");
    this.name = "VercelSandboxConnectionMissingError";
  }
}

export class VercelSandboxConnectionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VercelSandboxConnectionInvalidError";
  }
}

export class VercelSandboxConnectionMutationInProgressError extends Error {
  constructor() {
    super("Vercel Sandbox connection update is already in progress. Try again shortly.");
    this.name = "VercelSandboxConnectionMutationInProgressError";
  }
}

export class VercelSandboxConnectionActiveWorkError extends Error {
  constructor() {
    super(
      "Cannot change Vercel while Wallie runs or sandbox checks are queued or running. Wait for them to finish first.",
    );
    this.name = "VercelSandboxConnectionActiveWorkError";
  }
}

export async function acquireVercelSandboxConnectionMutationLock(
  admin: AdminClient,
  workspaceId: string,
): Promise<() => Promise<void>> {
  const { data, error } = await admin.rpc("begin_vercel_sandbox_connection_mutation", {
    target_workspace_id: workspaceId,
  });

  if (error) throw error;
  if (data === "locked") {
    throw new VercelSandboxConnectionMutationInProgressError();
  }
  if (data === "active") {
    throw new VercelSandboxConnectionActiveWorkError();
  }
  if (typeof data !== "string" || data.length === 0) {
    throw new Error("Failed to acquire Vercel Sandbox connection update lock.");
  }

  return async () => {
    const { error: releaseError } = await admin
      .from("workspace_vercel_sandbox_connection_mutations")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("lock_id", data);

    if (releaseError) throw releaseError;
  };
}

export function mapVercelSandboxConnectionPreview(
  row: Pick<
    ConnectionRow,
    | "connection_revision"
    | "last_validated_at"
    | "last_validation_error"
    | "project_id"
    | "project_name"
    | "status"
    | "team_id"
    | "token_preview"
    | "updated_at"
    | "workspace_id"
  >,
): VercelSandboxConnectionPreview {
  const status: VercelSandboxConnectionStatus = row.status === "connected" ? "connected" : "error";

  return {
    connectionRevision: row.connection_revision,
    lastValidatedAt: row.last_validated_at,
    lastValidationError: row.last_validation_error,
    projectId: row.project_id,
    projectName: row.project_name,
    status,
    teamId: row.team_id,
    tokenPreview: row.token_preview,
    updatedAt: row.updated_at,
    workspaceId: row.workspace_id,
  };
}

async function fetchVercelProject(input: VercelSandboxCredentials): Promise<
  | {
      ok: true;
      projectName: string | null;
    }
  | {
      error: string;
      ok: false;
    }
> {
  const url = new URL(`https://api.vercel.com/v9/projects/${encodeURIComponent(input.projectId)}`);
  url.searchParams.set("teamId", input.teamId);

  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${input.token}`,
      },
    });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "Failed to reach the Vercel API.",
      ok: false,
    };
  }

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      return {
        error: "Vercel rejected the token or team access.",
        ok: false,
      };
    }
    if (response.status === 404) {
      return {
        error: "Vercel project not found for that team.",
        ok: false,
      };
    }
    return {
      error: `Vercel project validation failed with status ${response.status}.`,
      ok: false,
    };
  }

  const body = (await response.json().catch(() => null)) as { name?: unknown } | null;
  return {
    ok: true,
    projectName: typeof body?.name === "string" ? body.name : null,
  };
}

export async function validateVercelSandboxCredentials(
  credentials: VercelSandboxCredentials,
): Promise<
  | {
      ok: true;
      projectName: string | null;
    }
  | {
      error: string;
      ok: false;
    }
> {
  const project = await fetchVercelProject(credentials);
  if (!project.ok) {
    return {
      ...project,
      error: redactSecrets(project.error, [credentials.token]),
    };
  }

  try {
    await Sandbox.list({
      limit: 1,
      projectId: credentials.projectId,
      teamId: credentials.teamId,
      token: credentials.token,
    });
  } catch (error) {
    return {
      error: redactSecrets(
        error instanceof Error
          ? error.message
          : "Vercel Sandbox validation failed for that project.",
        [credentials.token],
      ),
      ok: false,
    };
  }

  return project;
}

export async function loadVercelSandboxConnectionPreview(
  admin: AdminClient,
  workspaceId: string,
): Promise<VercelSandboxConnectionPreview | null> {
  const { data, error } = await admin
    .from("workspace_vercel_sandbox_connections")
    .select(previewSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapVercelSandboxConnectionPreview(data as ConnectionRow) : null;
}

export async function loadVercelSandboxConnection(
  admin: AdminClient,
  workspaceId: string,
): Promise<{
  credentials: VercelSandboxCredentials;
  preview: VercelSandboxConnectionPreview;
} | null> {
  const { data, error } = await admin
    .from("workspace_vercel_sandbox_connections")
    .select(secretSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const row = data as ConnectionRow;
  return {
    credentials: {
      projectId: row.project_id,
      teamId: row.team_id,
      token: decryptSecretValue(row.encrypted_token),
    },
    preview: mapVercelSandboxConnectionPreview(row),
  };
}

export async function loadRequiredVercelSandboxConnection(
  admin: AdminClient,
  workspaceId: string,
): Promise<{
  credentials: VercelSandboxCredentials;
  preview: VercelSandboxConnectionPreview;
}> {
  const connection = await loadVercelSandboxConnection(admin, workspaceId);

  if (!connection) {
    throw new VercelSandboxConnectionMissingError();
  }

  if (connection.preview.status !== "connected") {
    throw new VercelSandboxConnectionInvalidError(
      connection.preview.lastValidationError ??
        "Saved Vercel Sandbox connection is not valid. Reconnect it in workspace settings.",
    );
  }

  return connection;
}

export async function loadConnectedVercelSandboxConnections(admin: AdminClient): Promise<
  Array<{
    credentials: VercelSandboxCredentials;
    preview: VercelSandboxConnectionPreview;
  }>
> {
  const { data, error } = await admin
    .from("workspace_vercel_sandbox_connections")
    .select(secretSelect)
    .eq("status", "connected");

  if (error) throw error;

  return ((data ?? []) as ConnectionRow[]).map((row) => ({
    credentials: {
      projectId: row.project_id,
      teamId: row.team_id,
      token: decryptSecretValue(row.encrypted_token),
    },
    preview: mapVercelSandboxConnectionPreview(row),
  }));
}

export async function saveVercelSandboxConnection(input: {
  admin: AdminClient;
  credentials: VercelSandboxCredentials;
  createdByMemberId: string;
  projectName: string | null;
  workspaceId: string;
}): Promise<VercelSandboxConnectionPreview> {
  const now = new Date().toISOString();
  const { data: existing, error: existingError } = await input.admin
    .from("workspace_vercel_sandbox_connections")
    .select("workspace_id, created_by_member_id")
    .eq("workspace_id", input.workspaceId)
    .maybeSingle();

  if (existingError) throw existingError;

  const { data, error } = await input.admin
    .from("workspace_vercel_sandbox_connections")
    .upsert(
      {
        created_by_member_id: existing?.created_by_member_id ?? input.createdByMemberId,
        encrypted_token: encryptSecretValue(input.credentials.token),
        last_validated_at: now,
        last_validation_error: null,
        project_id: input.credentials.projectId,
        project_name: input.projectName,
        status: "connected",
        team_id: input.credentials.teamId,
        token_preview: buildSecretPreview(input.credentials.token),
        workspace_id: input.workspaceId,
      },
      { onConflict: "workspace_id" },
    )
    .select(previewSelect)
    .single();

  if (error) throw error;
  return mapVercelSandboxConnectionPreview(data as ConnectionRow);
}
