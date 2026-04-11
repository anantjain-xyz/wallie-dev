import "server-only";

import { randomUUID } from "node:crypto";

import type { SlackInstallationSummary } from "@/features/slack/contracts";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

const installationSelect =
  "id, installed_at, team_id, team_name, updated_at, workspace_id";

type SlackOAuthTokenResponse = {
  access_token?: string;
  app_id?: string;
  bot_user_id?: string;
  error?: string;
  ok: boolean;
  team?: {
    id?: string;
    name?: string;
  };
};

export async function exchangeSlackOAuthCode(
  values: {
    code: string;
    redirectUri: string;
  },
  input: Record<string, string | undefined> = process.env,
): Promise<SlackOAuthTokenResponse> {
  const clientId = input.SLACK_CLIENT_ID?.trim();
  const clientSecret = input.SLACK_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("SLACK_CLIENT_ID and SLACK_CLIENT_SECRET are required.");
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: values.code,
    redirect_uri: values.redirectUri,
  });

  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    body,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    method: "POST",
  });

  const payload = (await response.json()) as SlackOAuthTokenResponse;

  if (!payload.ok || !payload.access_token || !payload.team?.id) {
    throw new Error(`Slack OAuth exchange failed: ${payload.error ?? "unknown_error"}`);
  }

  return payload;
}

function mapInstallationSummary(
  row: Pick<
    Tables<"slack_installations">,
    "id" | "installed_at" | "team_id" | "team_name" | "updated_at"
  >,
): SlackInstallationSummary {
  return {
    id: row.id,
    installedAt: row.installed_at,
    teamId: row.team_id,
    teamName: row.team_name,
    updatedAt: row.updated_at,
  };
}

type UpsertSlackInstallationInput = {
  botToken: string;
  teamId: string;
  teamName: string | null;
  workspaceId: string;
};

export async function upsertSlackInstallationForWorkspace(
  values: UpsertSlackInstallationInput,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const encryptedToken = encryptSecretValue(values.botToken, input);

  const { data: existingRows, error: existingError } = await admin
    .from("slack_installations")
    .select(installationSelect)
    .or(`workspace_id.eq.${values.workspaceId},team_id.eq.${values.teamId}`);

  if (existingError) {
    throw existingError;
  }

  const workspaceRow = (existingRows ?? []).find((row) => row.workspace_id === values.workspaceId);
  const teamRow = (existingRows ?? []).find((row) => row.team_id === values.teamId);
  const recordId = workspaceRow?.id ?? teamRow?.id ?? randomUUID();

  if (teamRow && teamRow.id !== recordId) {
    const { error: deleteDuplicateError } = await admin
      .from("slack_installations")
      .delete()
      .eq("id", teamRow.id);

    if (deleteDuplicateError) {
      throw deleteDuplicateError;
    }
  }

  if (workspaceRow || teamRow) {
    const { data, error } = await admin
      .from("slack_installations")
      .update({
        bot_token_encrypted: encryptedToken,
        team_id: values.teamId,
        team_name: values.teamName,
        workspace_id: values.workspaceId,
      })
      .eq("id", recordId)
      .select(installationSelect)
      .single();

    if (error) {
      throw error;
    }

    return mapInstallationSummary(data);
  }

  const { data, error } = await admin
    .from("slack_installations")
    .insert({
      bot_token_encrypted: encryptedToken,
      id: recordId,
      team_id: values.teamId,
      team_name: values.teamName,
      workspace_id: values.workspaceId,
    })
    .select(installationSelect)
    .single();

  if (error) {
    throw error;
  }

  return mapInstallationSummary(data);
}

export async function getSlackInstallationForWorkspace(
  workspaceId: string,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const { data, error } = await admin
    .from("slack_installations")
    .select(installationSelect)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data ? mapInstallationSummary(data) : null;
}

export async function deleteSlackInstallationForWorkspace(
  values: { installationId: string; workspaceId: string },
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const { error } = await admin
    .from("slack_installations")
    .delete()
    .eq("id", values.installationId)
    .eq("workspace_id", values.workspaceId);

  if (error) {
    throw error;
  }
}
