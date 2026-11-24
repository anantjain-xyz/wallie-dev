import "server-only";

import { createHash, createPublicKey, verify } from "node:crypto";

import { z } from "zod/v4";

import {
  slackAppIdSchema as appId,
  slackChannelIdSchema as channelId,
  slackTeamIdSchema as teamId,
  slackUserIdSchema as userId,
} from "./contracts";

export const slackBotScopes = [
  "app_mentions:read",
  "chat:write",
  "channels:read",
  "channels:history",
  "groups:read",
  "groups:history",
] as const;

const slackOrigin = "https://slack.com";
const callbackTimeoutMs = 8_000;
const catalogPageSize = 25;
const membershipPageSize = 200;
const membershipPageLimit = 4;

const errors = {
  unavailable: { status: 502, message: "Could not verify access with Slack." },
  access_denied: { status: 403, message: "Slack did not authorize this request." },
  scope_mismatch: { status: 409, message: "Slack returned a different workspace or app." },
  channel_unavailable: { status: 404, message: "The selected Slack channel is unavailable." },
  membership_incomplete: {
    status: 503,
    message: "Could not finish verifying Slack channel membership.",
  },
  unsupported_installation: { status: 422, message: "This Slack installation is unsupported." },
  invalid_identity: { status: 403, message: "Could not verify your Slack identity." },
  rate_limited: { status: 429, message: "Slack is rate limiting requests." },
  invalid_request: { status: 400, message: "The Slack request is invalid." },
};
type ProviderFailure = keyof typeof errors;

export class SlackProviderError extends Error {
  readonly status: number;

  constructor(readonly reason: ProviderFailure) {
    super(errors[reason].message);
    this.name = "SlackProviderError";
    this.status = errors[reason].status;
  }
}

const botId = z.string().regex(/^B[A-Z0-9]{1,63}$/u);
const opaqueValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[!-~]+$/u);
const cursorValue = z
  .string()
  .max(1024)
  .regex(/^[!-~]*$/u);
const providerName = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .regex(/^[^\p{Cc}]+$/u);
const scopeName = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_:.]*$/u);
const stateValue = z
  .string()
  .min(32)
  .max(256)
  .regex(/^[A-Za-z0-9_-]+$/u);
const base64url = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[A-Za-z0-9_-]+$/u);

const slackApiEnvelope = z.object({ ok: z.boolean(), error: z.string().optional() });
const botTokenResponse = z.object({
  token_type: z.literal("bot"),
  access_token: opaqueValue,
  app_id: appId,
  bot_user_id: userId,
  team: z.object({ id: teamId, name: providerName }).nullish(),
  scope: z.string().max(4096),
  is_enterprise_install: z.boolean().optional(),
  expires_in: z.number().optional(),
  refresh_token: opaqueValue.optional(),
});
const authTestResponse = z.object({ team_id: teamId, user_id: userId, bot_id: botId });
const channelResponse = z.object({
  id: channelId,
  name: providerName,
  is_private: z.boolean(),
  is_channel: z.boolean().optional(),
  is_group: z.boolean().optional(),
  is_im: z.boolean(),
  is_mpim: z.boolean(),
  is_archived: z.boolean(),
  is_member: z.boolean().optional(),
  is_shared: z.boolean(),
  is_ext_shared: z.boolean().optional(),
  is_org_shared: z.boolean().optional(),
  is_pending_ext_shared: z.boolean().optional(),
  is_frozen: z.boolean().optional(),
  context_team_id: teamId.optional(),
  shared_team_ids: z.array(teamId).max(64).optional(),
});
const responseMetadata = z.object({ next_cursor: cursorValue.nullish() }).optional();
const channelCatalogResponse = z.object({
  channels: z.array(z.unknown()).max(catalogPageSize),
  response_metadata: responseMetadata,
});
const botChannelsResponse = z.object({
  channels: z.array(z.object({ id: channelId })).max(membershipPageSize),
  response_metadata: responseMetadata,
});
const identityTokenResponse = z.object({
  access_token: opaqueValue,
  id_token: z.string().min(1).max(16_384),
});
const identityUserResponse = z.object({
  sub: userId,
  "https://slack.com/team_id": teamId,
  "https://slack.com/user_id": userId.optional(),
});
const rsaWebKey = z.object({
  kid: opaqueValue,
  kty: z.literal("RSA"),
  use: z.literal("sig").optional(),
  alg: z.literal("RS256").optional(),
  n: base64url,
  e: base64url,
});
const identityKeys = z.object({ keys: z.array(z.unknown()).min(1).max(32) });
const identityHeader = z.object({ kid: opaqueValue, alg: z.literal("RS256") });
const epochSeconds = z.number().int().positive().safe();
const identityClaims = z.object({
  iss: z.literal(slackOrigin),
  aud: opaqueValue,
  sub: userId,
  exp: epochSeconds,
  iat: epochSeconds,
  nonce: opaqueValue,
  at_hash: base64url.optional(),
  "https://slack.com/team_id": teamId.optional(),
  "https://slack.com/user_id": userId.optional(),
});

function parse<S extends z.ZodType>(schema: S, value: unknown, reason: ProviderFailure) {
  const result = schema.safeParse(value);
  if (!result.success) throw new SlackProviderError(reason);
  return result.data;
}

function httpsCallback(value: string) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash) {
      return value;
    }
  } catch {
    // The supplied URL is configuration data.
  }
  throw new SlackProviderError("invalid_request");
}

function authorizationUrl(
  path: "/oauth/v2/authorize" | "/openid/connect/authorize",
  input: { clientId: string; redirectUri: string; state: string; teamId?: string },
) {
  const url = new URL(path, slackOrigin);
  url.searchParams.set("client_id", parse(opaqueValue, input.clientId, "invalid_request"));
  url.searchParams.set("redirect_uri", httpsCallback(input.redirectUri));
  url.searchParams.set("state", parse(stateValue, input.state, "invalid_request"));
  if (input.teamId !== undefined) {
    url.searchParams.set("team", parse(teamId, input.teamId, "invalid_request"));
  }
  return url;
}

export function buildSlackInstallUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  teamId?: string;
}) {
  const url = authorizationUrl("/oauth/v2/authorize", input);
  url.searchParams.set("scope", slackBotScopes.join(","));
  return url;
}

export function buildSlackIdentityUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  teamId: string;
}) {
  const url = authorizationUrl("/openid/connect/authorize", input);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("nonce", parse(stateValue, input.nonce, "invalid_request"));
  return url;
}

function slackErrorReason(error: string | undefined): ProviderFailure {
  switch (error) {
    case "invalid_auth":
    case "invalid_code":
    case "access_denied":
    case "missing_scope":
    case "not_authed":
    case "account_inactive":
    case "token_revoked":
    case "token_expired":
    case "team_access_not_granted":
      return "access_denied";
    case "channel_not_found":
    case "not_in_channel":
    case "is_archived":
      return "channel_unavailable";
    case "ratelimited":
      return "rate_limited";
    case "invalid_cursor":
      return "invalid_request";
    default:
      return "unavailable";
  }
}

async function readJson(
  fetcher: typeof fetch,
  url: URL,
  options: RequestInit,
  signal: AbortSignal,
) {
  try {
    const response = await fetcher(url, {
      ...options,
      signal,
      redirect: "error",
      cache: "no-store",
    });
    if (response.status === 429) throw new SlackProviderError("rate_limited");
    if (response.status === 401 || response.status === 403) {
      throw new SlackProviderError("access_denied");
    }
    if (!response.ok) throw new SlackProviderError("unavailable");
    const body: unknown = await response.json();
    return body;
  } catch (error) {
    if (error instanceof SlackProviderError) throw error;
    throw new SlackProviderError("unavailable");
  }
}

type SlackMethod =
  | "oauth.v2.access"
  | "auth.test"
  | "conversations.list"
  | "conversations.info"
  | "users.conversations"
  | "openid.connect.token"
  | "openid.connect.userInfo";

type AuthorizationGuard = () => Promise<void>;

function slackClient(fetcher: typeof fetch, assertCurrent?: AuthorizationGuard) {
  const signal = AbortSignal.timeout(callbackTimeoutMs);
  return {
    async api<S extends z.ZodType>(
      method: SlackMethod,
      schema: S,
      input: { form: URLSearchParams } | { token: string; query?: URLSearchParams },
    ) {
      const url = new URL(`/api/${method}`, slackOrigin);
      if ("query" in input && input.query) url.search = input.query.toString();
      await assertCurrent?.();
      const body = await readJson(
        fetcher,
        url,
        "form" in input
          ? { method: "POST", body: input.form }
          : {
              method: input.query ? "GET" : "POST",
              headers: { Authorization: `Bearer ${input.token}` },
            },
        signal,
      );
      const envelope = parse(slackApiEnvelope, body, "unavailable");
      if (!envelope.ok) throw new SlackProviderError(slackErrorReason(envelope.error));
      return parse(schema, body, "unavailable");
    },
    async identityKeys() {
      const body = await readJson(
        fetcher,
        new URL("/openid/connect/keys", slackOrigin),
        {},
        signal,
      );
      return parse(identityKeys, body, "invalid_identity").keys;
    },
  };
}

type CodeExchange = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
};

function codeExchangeForm(input: CodeExchange) {
  return new URLSearchParams({
    client_id: parse(opaqueValue, input.clientId, "invalid_request"),
    client_secret: parse(opaqueValue, input.clientSecret, "invalid_request"),
    redirect_uri: httpsCallback(input.redirectUri),
    code: parse(opaqueValue, input.code, "invalid_request"),
  });
}

async function verifyBot(
  client: ReturnType<typeof slackClient>,
  input: { botAccessToken: string; teamId: string; botUserId?: string },
) {
  const token = parse(opaqueValue, input.botAccessToken, "invalid_request");
  const expected = parse(teamId, input.teamId, "invalid_request");
  const expectedBot =
    input.botUserId === undefined ? null : parse(userId, input.botUserId, "invalid_request");
  const actual = await client.api("auth.test", authTestResponse, { token });
  if (actual.team_id !== expected || (expectedBot !== null && actual.user_id !== expectedBot)) {
    throw new SlackProviderError("scope_mismatch");
  }
}

export async function exchangeSlackInstallCode(
  input: CodeExchange & { appId: string; expectedTeamId?: string },
  fetcher: typeof fetch = fetch,
) {
  const expectedAppId = parse(appId, input.appId, "invalid_request");
  const expectedTeamId =
    input.expectedTeamId === undefined
      ? null
      : parse(teamId, input.expectedTeamId, "invalid_request");
  const client = slackClient(fetcher);
  const grant = await client.api("oauth.v2.access", botTokenResponse, {
    form: codeExchangeForm(input),
  });
  if (
    grant.is_enterprise_install ||
    !grant.team ||
    grant.expires_in !== undefined ||
    grant.refresh_token
  ) {
    throw new SlackProviderError("unsupported_installation");
  }
  if (grant.app_id !== expectedAppId || (expectedTeamId && grant.team.id !== expectedTeamId)) {
    throw new SlackProviderError("scope_mismatch");
  }
  const grantedScopes = [
    ...new Set(
      parse(
        z.array(scopeName).max(100),
        grant.scope
          .split(",")
          .map((scope) => scope.trim())
          .filter(Boolean),
        "unavailable",
      ),
    ),
  ].sort();
  await verifyBot(client, {
    botAccessToken: grant.access_token,
    teamId: grant.team.id,
    botUserId: grant.bot_user_id,
  });
  return {
    appId: grant.app_id,
    teamId: grant.team.id,
    teamName: grant.team.name,
    botUserId: grant.bot_user_id,
    botAccessToken: grant.access_token,
    grantedScopes,
    missingScopes: slackBotScopes.filter((scope) => !grantedScopes.includes(scope)),
  };
}

function decodeIdentityPart(encoded: string) {
  try {
    const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return value;
  } catch {
    throw new SlackProviderError("invalid_identity");
  }
}

async function signedIdentityClaims(
  client: ReturnType<typeof slackClient>,
  response: z.output<typeof identityTokenResponse>,
  input: { clientId: string; nonce: string },
) {
  const [header, payload, signature] = parse(
    z.tuple([base64url, base64url, base64url]),
    response.id_token.split("."),
    "invalid_identity",
  );
  const { kid } = parse(identityHeader, decodeIdentityPart(header), "invalid_identity");
  const keys = (await client.identityKeys())
    .map((key) => rsaWebKey.safeParse(key))
    .flatMap((key) => (key.success && key.data.kid === kid ? [key.data] : []));
  if (keys.length !== 1) throw new SlackProviderError("invalid_identity");

  try {
    const publicKey = createPublicKey({ key: keys[0]!, format: "jwk" });
    if (
      !verify(
        "RSA-SHA256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature, "base64url"),
      )
    ) {
      throw new SlackProviderError("invalid_identity");
    }
  } catch {
    throw new SlackProviderError("invalid_identity");
  }

  const claims = parse(identityClaims, decodeIdentityPart(payload), "invalid_identity");
  const now = Math.floor(Date.now() / 1000);
  const accessTokenHash =
    claims.at_hash &&
    createHash("sha256")
      .update(response.access_token)
      .digest()
      .subarray(0, 16)
      .toString("base64url");
  if (
    claims.aud !== input.clientId ||
    claims.nonce !== input.nonce ||
    claims.exp <= now ||
    claims.iat > now + 30 ||
    claims.iat >= claims.exp ||
    (claims.at_hash && claims.at_hash !== accessTokenHash)
  ) {
    throw new SlackProviderError("invalid_identity");
  }
  return claims;
}

export async function exchangeSlackIdentityCode(
  input: CodeExchange & { nonce: string; expectedTeamId: string },
  fetcher: typeof fetch = fetch,
) {
  const expectedTeamId = parse(teamId, input.expectedTeamId, "invalid_request");
  const nonce = parse(stateValue, input.nonce, "invalid_request");
  const client = slackClient(fetcher);
  const form = codeExchangeForm(input);
  form.set("grant_type", "authorization_code");
  const response = await client.api("openid.connect.token", identityTokenResponse, { form });
  const claims = await signedIdentityClaims(client, response, { clientId: input.clientId, nonce });
  const user = await client.api("openid.connect.userInfo", identityUserResponse, {
    token: response.access_token,
  });
  if (
    user.sub !== claims.sub ||
    (user["https://slack.com/user_id"] && user["https://slack.com/user_id"] !== claims.sub) ||
    (claims["https://slack.com/user_id"] && claims["https://slack.com/user_id"] !== claims.sub)
  ) {
    throw new SlackProviderError("invalid_identity");
  }
  if (
    user["https://slack.com/team_id"] !== expectedTeamId ||
    (claims["https://slack.com/team_id"] && claims["https://slack.com/team_id"] !== expectedTeamId)
  ) {
    throw new SlackProviderError("scope_mismatch");
  }
  return { teamId: expectedTeamId, userId: claims.sub };
}

type BotScope = {
  botAccessToken: string;
  teamId: string;
  botUserId?: string;
  assertCurrent?: AuthorizationGuard;
};

function channelOption(channel: z.output<typeof channelResponse>, expectedTeamId: string) {
  if (
    !(channel.is_channel || channel.is_group) ||
    channel.is_im ||
    channel.is_mpim ||
    channel.is_archived ||
    channel.is_shared ||
    channel.is_ext_shared ||
    channel.is_org_shared ||
    channel.is_pending_ext_shared ||
    channel.is_frozen ||
    (channel.context_team_id && channel.context_team_id !== expectedTeamId) ||
    channel.shared_team_ids?.some((team) => team !== expectedTeamId)
  ) {
    return null;
  }
  return { id: channel.id, name: channel.name, isPrivate: channel.is_private };
}

export async function readSlackChannelCatalog(
  input: BotScope & { cursor?: string | null },
  fetcher: typeof fetch = fetch,
) {
  const client = slackClient(fetcher, input.assertCurrent);
  const cursor = input.cursor == null ? "" : parse(cursorValue, input.cursor, "invalid_request");
  await verifyBot(client, input);
  const query = new URLSearchParams({
    types: "public_channel,private_channel",
    exclude_archived: "true",
    limit: String(catalogPageSize),
  });
  if (cursor) query.set("cursor", cursor);
  const result = await client.api("conversations.list", channelCatalogResponse, {
    token: input.botAccessToken,
    query,
  });
  const nextCursor = result.response_metadata?.next_cursor || null;
  if (nextCursor && nextCursor === cursor) throw new SlackProviderError("unavailable");
  const channels = result.channels.flatMap((item) => {
    const parsed = channelResponse.safeParse(item);
    if (!parsed.success || parsed.data.is_member !== true) return [];
    const option = channelOption(parsed.data, input.teamId);
    return option ? [option] : [];
  });
  await input.assertCurrent?.();
  return { channels, nextCursor };
}

export async function verifySlackChannel(
  input: BotScope & { channelId: string; beforeMembershipLookup?: () => Promise<void> },
  fetcher: typeof fetch = fetch,
) {
  const id = parse(channelId, input.channelId, "invalid_request");
  const client = slackClient(fetcher, input.assertCurrent);
  await verifyBot(client, input);
  const { channel } = await client.api(
    "conversations.info",
    z.object({ channel: channelResponse }),
    {
      token: input.botAccessToken,
      query: new URLSearchParams({ channel: id }),
    },
  );
  const option = channel.id === id && channelOption(channel, input.teamId);
  if (!option || channel.is_member === false) throw new SlackProviderError("channel_unavailable");

  // Without is_member, users.conversations lists the verified bot token's own channels.
  const query = new URLSearchParams({
    types: channel.is_private ? "private_channel" : "public_channel",
    exclude_archived: "true",
    limit: String(membershipPageSize),
  });
  const seenCursors = new Set<string>();
  let member = channel.is_member === true;
  for (let page = 0; !member && page < membershipPageLimit; page++) {
    await input.beforeMembershipLookup?.();
    const result = await client.api("users.conversations", botChannelsResponse, {
      token: input.botAccessToken,
      query,
    });
    member = result.channels.some((item) => item.id === id);
    if (member) break;
    const cursor = result.response_metadata?.next_cursor;
    if (!cursor) throw new SlackProviderError("channel_unavailable");
    if (seenCursors.has(cursor)) throw new SlackProviderError("membership_incomplete");
    seenCursors.add(cursor);
    query.set("cursor", cursor);
  }
  if (!member) throw new SlackProviderError("membership_incomplete");
  await input.assertCurrent?.();
  return option;
}
