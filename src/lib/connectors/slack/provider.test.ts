import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  buildSlackIdentityUrl,
  buildSlackInstallUrl,
  exchangeSlackIdentityCode,
  exchangeSlackInstallCode,
  readSlackChannelCatalog,
  slackBotScopes,
  verifySlackChannel,
} from "./provider";

const workspace = "TWORKSPACE01";
const otherWorkspace = "TWORKSPACE02";
const app = "AWALLIE01";
const bot = "UBOT01";
const human = "UHUMAN01";
const channel = "CPUBLIC01";
const privateChannel = "GPRIVATE01";
const clientId = "1234.5678";
const clientSecret = "synthetic-private-client";
const botAccessToken = "xoxb-synthetic-private-bot";
const identityAccessToken = "xoxp-synthetic-private-human";
const nonce = "a".repeat(43);
const state = "b".repeat(43);
const redirectUri = "https://wallie.example.test/api/slack/callback";
const codeExchange = { clientId, clientSecret, redirectUri, code: "synthetic-slack-code" };
const installInput = { ...codeExchange, appId: app, expectedTeamId: workspace };
const identityInput = { ...codeExchange, nonce, expectedTeamId: workspace };
const botScope = { botAccessToken, teamId: workspace, botUserId: bot };

const installGrant = {
  ok: true,
  app_id: app,
  access_token: botAccessToken,
  token_type: "bot",
  bot_user_id: bot,
  team: { id: workspace, name: "Slack fixture" },
  scope: slackBotScopes.join(","),
  is_enterprise_install: false,
};
const auth = { ok: true, team_id: workspace, user_id: bot, bot_id: "BBOT01" };
const conversation = {
  id: channel,
  name: "wallie-public",
  is_private: false,
  is_channel: true,
  is_group: false,
  is_im: false,
  is_mpim: false,
  is_archived: false,
  is_member: true,
  is_shared: false,
  context_team_id: workspace,
};
const me = {
  ok: true,
  sub: human,
  "https://slack.com/user_id": human,
  "https://slack.com/team_id": workspace,
};

function slackFetch(...replies: unknown[]) {
  const fetcher = vi.fn<typeof fetch>();
  for (const reply of replies) fetcher.mockResolvedValueOnce(Response.json(reply));
  return fetcher;
}

function requestAt(fetcher: ReturnType<typeof slackFetch>, index: number) {
  const invocation = fetcher.mock.calls[index];
  expect(invocation).toBeDefined();
  return new Request(...invocation!);
}

const signingKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const publicJwk = {
  ...signingKeys.publicKey.export({ format: "jwk" }),
  kid: "slack-test",
  alg: "RS256",
  use: "sig",
};

function identityGrant(
  overrides: Record<string, unknown> = {},
  options: { algorithm?: string; corruptSignature?: boolean } = {},
) {
  const time = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ kid: publicJwk.kid, alg: options.algorithm ?? publicJwk.alg });
  const payload = encode({
    iss: "https://slack.com",
    aud: clientId,
    sub: human,
    iat: time - 5,
    exp: time + 300,
    nonce,
    at_hash: createHash("sha256")
      .update(identityAccessToken)
      .digest()
      .subarray(0, 16)
      .toString("base64url"),
    ...overrides,
  });
  const signed = `${header}.${payload}`;
  const signature = options.corruptSignature
    ? Buffer.alloc(256).toString("base64url")
    : sign("RSA-SHA256", Buffer.from(signed), signingKeys.privateKey).toString("base64url");
  return { ok: true, access_token: identityAccessToken, id_token: `${signed}.${signature}` };
}

describe("Slack authorization URLs", () => {
  it("keeps workspace bot installation and least-privilege human identity separate", () => {
    const install = buildSlackInstallUrl({ clientId, redirectUri, state, teamId: workspace });
    expect(install.origin + install.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(Object.fromEntries(install.searchParams)).toEqual({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      team: workspace,
      scope: slackBotScopes.join(","),
    });
    const identity = buildSlackIdentityUrl({
      clientId,
      redirectUri,
      state,
      nonce,
      teamId: workspace,
    });
    expect(identity.origin + identity.pathname).toBe("https://slack.com/openid/connect/authorize");
    expect(Object.fromEntries(identity.searchParams)).toEqual({
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      team: workspace,
      response_type: "code",
      scope: "openid",
      nonce,
    });
    expect(() =>
      buildSlackInstallUrl({ clientId, redirectUri: "http://wallie.example.test", state }),
    ).toThrow("The Slack request is invalid.");
  });
});

describe("Slack installation proof", () => {
  it("verifies the exact app, workspace and bot and reports actual and missing scopes", async () => {
    const fetcher = slackFetch(
      { ...installGrant, scope: "chat:write,channels:read,chat:write" },
      auth,
    );
    await expect(exchangeSlackInstallCode(installInput, fetcher)).resolves.toEqual({
      appId: app,
      teamId: workspace,
      teamName: "Slack fixture",
      botUserId: bot,
      botAccessToken,
      grantedScopes: ["channels:read", "chat:write"],
      missingScopes: ["app_mentions:read", "channels:history", "groups:read", "groups:history"],
    });

    const exchange = requestAt(fetcher, 0);
    expect(exchange.url).toBe("https://slack.com/api/oauth.v2.access");
    expect(exchange.method).toBe("POST");
    expect(exchange.redirect).toBe("error");
    expect(Object.fromEntries(await exchange.formData())).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: codeExchange.code,
    });
    const verify = requestAt(fetcher, 1);
    expect(verify.url).toBe("https://slack.com/api/auth.test");
    expect(verify.headers.get("Authorization")).toBe(`Bearer ${botAccessToken}`);
    expect(verify.redirect).toBe("error");
    expect(fetcher.mock.calls[0]?.[1]?.signal).toBe(fetcher.mock.calls[1]?.[1]?.signal);
  });

  it.each([
    [{ app_id: "AOTHER01" }, "scope_mismatch"],
    [{ team: { id: otherWorkspace, name: "Other" } }, "scope_mismatch"],
    [{ is_enterprise_install: true, team: null }, "unsupported_installation"],
    [{ expires_in: 3600, refresh_token: "synthetic-refresh-token" }, "unsupported_installation"],
  ] as const)(
    "rejects unsupported or mismatched OAuth grants before using their token",
    async (override, reason) => {
      const fetcher = slackFetch({ ...installGrant, ...override });
      await expect(exchangeSlackInstallCode(installInput, fetcher)).rejects.toMatchObject({
        reason,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("never treats a different bot or workspace from auth.test as the OAuth grant", async () => {
    for (const mismatch of [{ user_id: "UOTHER01" }, { team_id: otherWorkspace }]) {
      const fetcher = slackFetch(installGrant, { ...auth, ...mismatch });
      await expect(exchangeSlackInstallCode(installInput, fetcher)).rejects.toMatchObject({
        reason: "scope_mismatch",
        status: 409,
      });
    }
  });

  it("redacts failures and refuses redirects", async () => {
    const message = "Could not verify access with Slack.";
    const redirect = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(null, {
        status: 302,
        headers: { Location: "https://external.example.test/" },
      }),
    );
    const failure = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error(clientSecret));
    const malformed = slackFetch({ ...installGrant, team: { id: botAccessToken } });
    for (const fetcher of [redirect, failure, malformed]) {
      await expect(exchangeSlackInstallCode(installInput, fetcher)).rejects.toMatchObject({
        reason: "unavailable",
        message,
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestAt(fetcher, 0).redirect).toBe("error");
    }
  });
});

describe("Slack channel authority", () => {
  it("lists only eligible bot-member channels and gives the provider cursor even after filtering", async () => {
    const fetcher = slackFetch(auth, {
      ok: true,
      channels: [
        conversation,
        { ...conversation, id: privateChannel, name: "wallie-private", is_private: true },
        { ...conversation, id: "CNOMEMBER01", is_member: false },
        { ...conversation, id: "CARCHIVED01", is_archived: true },
        { ...conversation, id: "CSHARED01", is_shared: true },
        { ...conversation, id: "CFOREIGN01", context_team_id: otherWorkspace },
        { ...conversation, id: "DDIRECT01", is_im: true },
        { ...conversation, id: "GGROUPDM01", is_mpim: true },
      ],
      response_metadata: { next_cursor: "next-page=" },
    });
    await expect(
      readSlackChannelCatalog({ ...botScope, cursor: "current-page=" }, fetcher),
    ).resolves.toEqual({
      channels: [
        { id: channel, name: "wallie-public", isPrivate: false },
        { id: privateChannel, name: "wallie-private", isPrivate: true },
      ],
      nextCursor: "next-page=",
    });
    const list = new URL(requestAt(fetcher, 1).url);
    expect(list.origin + list.pathname).toBe("https://slack.com/api/conversations.list");
    expect(Object.fromEntries(list.searchParams)).toEqual({
      types: "public_channel,private_channel",
      exclude_archived: "true",
      limit: "25",
      cursor: "current-page=",
    });
  });

  it("fails before a channel listing when the token belongs to a different Slack workspace", async () => {
    const fetcher = slackFetch({ ...auth, team_id: otherWorkspace });
    await expect(readSlackChannelCatalog(botScope, fetcher)).rejects.toMatchObject({
      reason: "scope_mismatch",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each(["catalog", "mapping"] as const)(
    "keeps the scoped %s authorization failure if access ends during auth.test",
    async (operation) => {
      const revoked = new Error("The Slack installation changed.");
      let authorized = true;
      const assertCurrent = vi.fn(async () => {
        if (!authorized) throw revoked;
      });
      const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => {
        authorized = false;
        return Response.json(auth);
      });
      const scope = { ...botScope, assertCurrent };
      const result =
        operation === "catalog"
          ? readSlackChannelCatalog(scope, fetcher)
          : verifySlackChannel({ ...scope, channelId: channel }, fetcher);
      await expect(result).rejects.toBe(revoked);
      expect(assertCurrent).toHaveBeenCalledTimes(2);
      expect(fetcher).toHaveBeenCalledTimes(1);
      expect(requestAt(fetcher, 0).url).toBe("https://slack.com/api/auth.test");
    },
  );

  it.each(["catalog", "mapping"] as const)(
    "withholds %s metadata if access ends while reading the channel",
    async (operation) => {
      const revoked = new Error("The Slack installation changed.");
      let authorized = true;
      const assertCurrent = vi.fn(async () => {
        if (!authorized) throw revoked;
      });
      const fetcher = slackFetch(auth).mockImplementationOnce(async () => {
        authorized = false;
        return Response.json({ ok: true, channels: [conversation], channel: conversation });
      });
      const scope = { ...botScope, assertCurrent };
      const result =
        operation === "catalog"
          ? readSlackChannelCatalog(scope, fetcher)
          : verifySlackChannel({ ...scope, channelId: channel }, fetcher);
      await expect(result).rejects.toBe(revoked);
      expect(assertCurrent).toHaveBeenCalledTimes(3);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );

  it("verifies exact channel membership even if conversations.info omits the membership flag", async () => {
    const assertCurrent = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const fetcher = slackFetch(
      auth,
      { ok: true, channel: { ...conversation, is_member: undefined, name: "wallie-renamed" } },
      { ok: true, members: ["UOTHER01"], response_metadata: { next_cursor: "next-members=" } },
      { ok: true, members: [bot], response_metadata: { next_cursor: "" } },
    );
    await expect(
      verifySlackChannel({ ...botScope, channelId: channel, assertCurrent }, fetcher),
    ).resolves.toEqual({ id: channel, name: "wallie-renamed", isPrivate: false });
    expect(assertCurrent).toHaveBeenCalledTimes(5);
    expect(new URL(requestAt(fetcher, 1).url).searchParams.get("channel")).toBe(channel);
    const members = new URL(requestAt(fetcher, 3).url);
    expect(members.origin + members.pathname).toBe("https://slack.com/api/conversations.members");
    expect(Object.fromEntries(members.searchParams)).toEqual({
      channel,
      limit: "200",
      cursor: "next-members=",
    });
  });

  it.each([
    { id: "COTHER01" },
    { is_member: false },
    { is_archived: true },
    { is_ext_shared: true },
    { is_org_shared: true },
    { is_pending_ext_shared: true },
    { shared_team_ids: [workspace, otherWorkspace] },
    { is_im: true },
    { is_mpim: true },
  ])("denies a substitute or unauthorized live channel without joining it", async (override) => {
    const fetcher = slackFetch(auth, { ok: true, channel: { ...conversation, ...override } });
    await expect(
      verifySlackChannel({ ...botScope, channelId: channel }, fetcher),
    ).rejects.toMatchObject({
      reason: "channel_unavailable",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("Slack human identity proof", () => {
  const jwks = { keys: [publicJwk] };

  it("binds the Slack-signed subject to the exact workspace in Slack userinfo and returns no token", async () => {
    const fetcher = slackFetch(identityGrant(), jwks, me);
    await expect(exchangeSlackIdentityCode(identityInput, fetcher)).resolves.toEqual({
      teamId: workspace,
      userId: human,
    });
    const token = requestAt(fetcher, 0);
    expect(token.url).toBe("https://slack.com/api/openid.connect.token");
    expect(Object.fromEntries(await token.formData())).toEqual({
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      code: codeExchange.code,
      grant_type: "authorization_code",
    });
    expect(requestAt(fetcher, 1).url).toBe("https://slack.com/openid/connect/keys");
    const userinfo = requestAt(fetcher, 2);
    expect(userinfo.url).toBe("https://slack.com/api/openid.connect.userInfo");
    expect(userinfo.headers.get("Authorization")).toBe(`Bearer ${identityAccessToken}`);
    expect(fetcher.mock.calls.every(([, init]) => init?.redirect === "error")).toBe(true);
  });

  it.each([
    [{ aud: "other-app" }, {}],
    [{ iss: "https://untrusted.example.test" }, {}],
    [{ nonce: "wrong-nonce" }, {}],
    [{ exp: 1000 }, {}],
    [{ at_hash: "wrong-hash" }, {}],
    [{}, { algorithm: "none" }],
    [{}, { corruptSignature: true }],
  ])("rejects an invalid signed proof before reading any userinfo", async (overrides, options) => {
    const fetcher = slackFetch(identityGrant(overrides, options), jwks);
    await expect(exchangeSlackIdentityCode(identityInput, fetcher)).rejects.toMatchObject({
      reason: "invalid_identity",
    });
    expect(fetcher.mock.calls.map((_, index) => requestAt(fetcher, index).url)).not.toContain(
      "https://slack.com/api/openid.connect.userInfo",
    );
  });

  it.each([
    [{}, { "https://slack.com/team_id": otherWorkspace }, "scope_mismatch"],
    [{ "https://slack.com/team_id": otherWorkspace }, {}, "scope_mismatch"],
    [{}, { sub: "UOTHER01" }, "invalid_identity"],
    [{}, { "https://slack.com/user_id": "UOTHER01" }, "invalid_identity"],
    [{ "https://slack.com/user_id": "UOTHER01" }, {}, "invalid_identity"],
  ] as const)(
    "requires independently verified Slack subject and tenant to agree",
    async (claims, overrides, reason) => {
      const fetcher = slackFetch(identityGrant(claims), jwks, { ...me, ...overrides });
      await expect(exchangeSlackIdentityCode(identityInput, fetcher)).rejects.toMatchObject({
        reason,
      });
    },
  );
});
