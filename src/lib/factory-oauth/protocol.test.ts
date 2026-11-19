import { describe, expect, it } from "vitest";

import {
  factoryOAuthRedirect,
  factoryOAuthRedirectUriSchema,
  parseFactoryOAuthAuthorization,
} from "./protocol";
import {
  factoryOAuthPKCEChallenge,
  issueFactoryOAuthCredential,
  parseFactoryOAuthCredential,
} from "./credentials";

const registered = "https://Client.example.test/callback?view=a%20b";
const clientId = "aca1c4bf-9836-444a-a48b-b7e20ed21c8f";
const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const issuer = "https://wallie.example.test";

function authorizationRequest() {
  return new URLSearchParams({
    client_id: clientId,
    redirect_uri: registered,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    scope: "sessions:read sessions:create",
    state: "client state",
  });
}

describe("factory OAuth authorization protocol", () => {
  it("preserves the registered redirect exactly and computes the RFC 7636 proof", () => {
    expect(factoryOAuthPKCEChallenge(verifier)).toBe(challenge);
    expect(parseFactoryOAuthAuthorization(authorizationRequest())).toEqual({
      ok: true,
      request: {
        clientId,
        redirectUri: registered,
        challenge,
        scopes: ["sessions:read", "sessions:create"],
        state: "client state",
      },
    });
  });

  it.each([
    "http://clients.example.test/callback",
    "http://localhost:3000/callback",
    "http://127.1:3000/callback",
    "http://127.0.0.1/callback",
    "https://name:password@client.example.test/callback",
    "https://*.example.test/callback",
    "https://client.example.test/callback#",
    "https://client.example.test/callback/%ZZ",
    "https://client.example.test/callback?st%61te=preset",
    "https://client.example.test/callback\n",
    "javascript:alert(1)",
  ])("rejects an invalid redirect URI %j", (redirect) => {
    expect(factoryOAuthRedirectUriSchema.safeParse(redirect).success).toBe(false);
  });

  it.each(["http://127.0.0.1:41325/callback", "http://[::1]:41325/callback"])(
    "allows a specific registered IP loopback URI %s",
    (redirect) => {
      expect(factoryOAuthRedirectUriSchema.parse(redirect)).toBe(redirect);
    },
  );

  it("retains the registered query and escapes the returned state", () => {
    const callback = factoryOAuthRedirect({
      issuer,
      redirectUri: registered,
      state: "value&code=injected",
      response: { kind: "error", error: "access_denied" },
    });

    expect(callback.search).toBe(
      "?view=a%20b&error=access_denied&state=value%26code%3Dinjected&iss=https%3A%2F%2Fwallie.example.test",
    );
    expect(callback.searchParams.has("code")).toBe(false);
  });

  it("preserves explicit resource intent and marks multiple resources as invalid", () => {
    const query = authorizationRequest();
    const resource = `${issuer}/api/v1/workspaces/${clientId}/factories/${clientId}/mcp`;
    query.set("resource", resource);
    expect(parseFactoryOAuthAuthorization(query)).toMatchObject({
      ok: true,
      request: { resource },
    });
    query.append("resource", resource);
    expect(parseFactoryOAuthAuthorization(query)).toMatchObject({
      ok: true,
      request: { resource: "" },
    });
  });

  it("rejects duplicate parameters and proof downgrade", () => {
    const duplicates = authorizationRequest();
    duplicates.append("redirect_uri", "https://another.example.test/callback");
    expect(parseFactoryOAuthAuthorization(duplicates)).toMatchObject({
      ok: false,
      error: "invalid_request",
    });

    const downgraded = authorizationRequest();
    downgraded.set("code_challenge_method", "plain");
    expect(parseFactoryOAuthAuthorization(downgraded)).toMatchObject({
      ok: false,
      error: "invalid_request",
    });
  });

  it("rejects implicit responses and unrecognized scopes", () => {
    const implicit = authorizationRequest();
    implicit.set("response_type", "token");
    expect(parseFactoryOAuthAuthorization(implicit)).toMatchObject({
      ok: false,
      error: "unsupported_response_type",
    });

    const invalidScope = authorizationRequest();
    invalidScope.set("scope", "sessions:approve");
    expect(parseFactoryOAuthAuthorization(invalidScope)).toMatchObject({
      ok: false,
      error: "invalid_scope",
    });
  });
});

describe("factory OAuth credentials", () => {
  it("uses separate credential purposes and submits only digests for validation", () => {
    const code = issueFactoryOAuthCredential("code");
    const access = issueFactoryOAuthCredential("access");
    const refresh = issueFactoryOAuthCredential("refresh");

    expect(access.credential).not.toBe(refresh.credential);
    expect(parseFactoryOAuthCredential("code", code.credential)).toEqual({
      id: code.id,
      digest: code.digest,
    });
    expect(parseFactoryOAuthCredential("access", code.credential)).toBeNull();
    expect(parseFactoryOAuthCredential("refresh", access.credential)).toBeNull();
    expect(parseFactoryOAuthCredential("refresh", refresh.credential)).toEqual({
      id: refresh.id,
      digest: refresh.digest,
    });
  });
});
