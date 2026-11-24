import "server-only";

import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { parseServerEnv } from "@/env/server";
import { linkConnectorActor, revokeConnectorActorLink } from "@/lib/connectors/actors";
import { decryptSecretValue, encryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import { slackAppIdSchema, type SlackConnectorSetupCommand } from "./contracts";
import {
  buildSlackIdentityUrl,
  buildSlackInstallUrl,
  exchangeSlackIdentityCode,
  exchangeSlackInstallCode,
  readSlackChannelCatalog,
  slackBotScopes,
  verifySlackChannel,
} from "./provider";

type Admin = SupabaseClient<Database>;
type Scope = {
  p_workspace_id: string;
  p_factory_id: string;
  p_actor_user_id: string;
};

type SlackOAuthFlow = {
  purpose: "install" | "link";
  teamId: string;
  installationId: string | null;
  expectedGeneration: number;
};

export const slackCallbackPath = "/api/slack/callback";
export const slackCallbackInput = z
  .object({
    state: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^[^\s\p{Cc}]+$/u)
      .optional(),
    error: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-z0-9_]+$/)
      .optional(),
  })
  .refine(({ code, error }) => Boolean(code) !== Boolean(error));

export class SlackSetupFailure extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function slackConnectorConfig(env = parseServerEnv()) {
  const appId = slackAppIdSchema.safeParse(env.SLACK_APP_ID);
  const appUrl = new URL(env.NEXT_PUBLIC_APP_URL);
  if (
    !appId.success ||
    !env.SLACK_CLIENT_ID ||
    !env.SLACK_CLIENT_SECRET ||
    !env.SLACK_SIGNING_SECRET ||
    appUrl.protocol !== "https:" ||
    appUrl.username ||
    appUrl.password
  )
    return null;

  return {
    appId: appId.data,
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    redirectUri: new URL(slackCallbackPath, appUrl).href,
  };
}

function requireSlackConnectorConfig() {
  const config = slackConnectorConfig();
  if (!config)
    throw new SlackSetupFailure(
      503,
      "Slack setup requires app credentials and an HTTPS Wallie URL.",
    );
  return config;
}

function stateDigest(state: string, sessionId: string) {
  return createHash("sha256").update(`slack-state:${sessionId}:${state}`).digest("hex");
}

function identityNonce(state: string) {
  return createHash("sha256").update(`slack-identity:${state}`).digest("base64url");
}

async function readSetupRows(admin: Admin, scope: Scope) {
  const { data, error } = await admin.rpc("read_slack_connector_setup", scope);
  if (error) throw error;
  return data;
}

export async function readSlackConnectorSetup(admin: Admin, scope: Scope, canConfigure: boolean) {
  const config = slackConnectorConfig();
  const rows = await readSetupRows(admin, scope);
  return {
    configured: config !== null,
    canConfigure,
    installations: rows.map((row) => ({
      id: row.installation_id,
      teamId: row.team_id,
      teamName: row.team_name,
      generation: row.generation,
      status:
        row.status === "connected" && row.app_id !== config?.appId
          ? "credential_unavailable"
          : row.status,
      grantedScopes: row.granted_scopes,
      missingScopes: slackBotScopes.filter((item) => !row.granted_scopes.includes(item)),
      linkedActor:
        row.actor_link_id && row.actor_user_id
          ? { id: row.actor_link_id, userId: row.actor_user_id }
          : null,
    })),
  };
}

export async function startSlackConnectorAuthorization(
  admin: Admin,
  scope: Scope,
  sessionId: string,
  command: Exclude<SlackConnectorSetupCommand, { action: "revoke" }>,
) {
  const config = requireSlackConnectorConfig();
  const state = randomBytes(32).toString("base64url");
  let flow: SlackOAuthFlow;
  let url: URL;
  if (command.action === "install") {
    flow = {
      purpose: "install",
      teamId: command.teamId,
      installationId: null,
      expectedGeneration: command.expectedGeneration,
    };
    url = buildSlackInstallUrl({ ...config, state, teamId: flow.teamId });
  } else {
    const installation = (await readSetupRows(admin, scope)).find(
      (row) => row.installation_id === command.installationId,
    );
    if (
      !installation ||
      installation.status !== "connected" ||
      installation.app_id !== config.appId
    ) {
      throw new SlackSetupFailure(409, "Connect this Slack workspace before linking an account.");
    }
    flow = {
      purpose: "link",
      teamId: installation.team_id,
      installationId: command.installationId,
      expectedGeneration: command.expectedGeneration,
    };
    url = buildSlackIdentityUrl({
      ...config,
      state,
      teamId: flow.teamId,
      nonce: identityNonce(state),
    });
  }

  const { data, error } = await admin.rpc("start_slack_connector_oauth", {
    ...scope,
    p_purpose: flow.purpose,
    p_team_id: flow.teamId,
    p_expected_generation: flow.expectedGeneration,
    p_state_digest: stateDigest(state, sessionId),
    ...(flow.installationId ? { p_installation_id: flow.installationId } : {}),
  });
  if (error) throw error;
  if (data !== true) throw new SlackSetupFailure(409, "Could not start Slack authorization.");
  return { authorizationUrl: url.href };
}

export async function consumeSlackConnectorAuthorization(
  admin: Admin,
  input: { state: string; userId: string; sessionId: string },
) {
  const { data, error } = await admin.rpc("consume_slack_connector_oauth", {
    p_state_digest: stateDigest(input.state, input.sessionId),
    p_actor_user_id: input.userId,
  });
  if (error) throw error;
  return data[0] ?? null;
}

type ConsumedFlow = NonNullable<Awaited<ReturnType<typeof consumeSlackConnectorAuthorization>>>;

export async function completeSlackConnectorAuthorization(
  admin: Admin,
  scope: Scope,
  flow: ConsumedFlow,
  input: { state: string; code: string },
) {
  const config = requireSlackConnectorConfig();
  const exchange = { ...config, code: input.code, expectedTeamId: flow.team_id };
  if (flow.purpose === "install") {
    const verified = await exchangeSlackInstallCode(exchange);
    const { error } = await admin.rpc("configure_slack_connector_installation", {
      ...scope,
      p_app_id: verified.appId,
      p_bot_user_id: verified.botUserId,
      p_team_id: verified.teamId,
      p_team_name: verified.teamName,
      p_expected_generation: flow.expected_generation,
      p_encrypted_token: encryptSecretValue(verified.botAccessToken),
      p_granted_scopes: verified.grantedScopes,
    });
    if (error) throw error;
    return "installed";
  }
  if (flow.purpose !== "link" || !flow.installation_id) {
    throw new SlackSetupFailure(400, "Slack authorization could not be verified.");
  }
  const installation = (await readSetupRows(admin, scope)).find(
    (row) => row.installation_id === flow.installation_id,
  );
  if (
    installation?.status !== "connected" ||
    installation.app_id !== config.appId ||
    installation.generation !== flow.expected_generation ||
    installation.team_id !== flow.team_id
  )
    throw new SlackSetupFailure(409, "The Slack installation changed. Reopen Slack settings.");

  const actor = await exchangeSlackIdentityCode({ ...exchange, nonce: identityNonce(input.state) });
  await linkConnectorActor(admin, {
    workspaceId: scope.p_workspace_id,
    factoryId: scope.p_factory_id,
    actorUserId: scope.p_actor_user_id,
    installationId: flow.installation_id,
    installationGeneration: flow.expected_generation,
    actor: {
      kind: "human",
      provider: "slack",
      externalTenantId: actor.teamId,
      externalActorId: actor.userId,
    },
  });
  return "linked";
}

export async function revokeOwnSlackLink(
  admin: Admin,
  scope: Scope,
  command: Extract<SlackConnectorSetupCommand, { action: "revoke" }>,
) {
  const own = (await readSetupRows(admin, scope)).find(
    (row) => row.installation_id === command.installationId && row.actor_link_id === command.linkId,
  );
  if (!own) throw new SlackSetupFailure(404, "Your Slack identity link is unavailable.");
  return {
    revoked: await revokeConnectorActorLink(admin, {
      workspaceId: scope.p_workspace_id,
      actorUserId: scope.p_actor_user_id,
      linkId: command.linkId,
    }),
  };
}

async function readSlackSetupCredential(
  admin: Admin,
  scope: Scope,
  installationId: string,
  generation: number,
) {
  const config = requireSlackConnectorConfig();
  async function readCurrentCredential() {
    const { data, error } = await admin.rpc("read_slack_connector_credential", {
      ...scope,
      p_installation_id: installationId,
      p_expected_generation: generation,
    });
    if (error) throw error;
    const [credential] = data;
    if (!credential || credential.app_id !== config.appId) {
      throw new SlackSetupFailure(
        409,
        "The Slack installation is unavailable. Reconnect it before continuing.",
      );
    }
    return credential;
  }
  const credential = await readCurrentCredential();
  return {
    teamId: credential.team_id,
    botUserId: credential.bot_user_id,
    botAccessToken: decryptSecretValue(credential.encrypted_token),
    async assertCurrent() {
      await readCurrentCredential();
    },
  };
}

export async function readMappedSlackChannelCatalog(
  admin: Admin,
  scope: Scope,
  input: { installationId: string; cursor?: string },
) {
  const row = (await readSetupRows(admin, scope)).find(
    (installation) => installation.installation_id === input.installationId,
  );
  if (!row || row.status !== "connected") {
    throw new SlackSetupFailure(409, "Connect Slack before selecting channels.");
  }
  const credential = await readSlackSetupCredential(
    admin,
    scope,
    row.installation_id,
    row.generation,
  );
  const page = await readSlackChannelCatalog({ ...credential, cursor: input.cursor });
  return {
    tenant: { id: row.team_id, label: row.team_name },
    resources: page.channels.map((channel) => ({
      id: channel.id,
      label: channel.isPrivate ? `#${channel.name} (private)` : `#${channel.name}`,
    })),
    nextCursor: page.nextCursor,
  };
}

export async function verifyMappedSlackChannel(
  admin: Admin,
  scope: Scope,
  input: { installationId: string; generation: number; teamId: string; channelId: string },
) {
  const credential = await readSlackSetupCredential(
    admin,
    scope,
    input.installationId,
    input.generation,
  );
  if (credential.teamId !== input.teamId) {
    throw new SlackSetupFailure(409, "Slack workspace changed. Reopen Slack settings.");
  }
  return verifySlackChannel({ ...credential, channelId: input.channelId });
}
