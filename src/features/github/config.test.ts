import { createPrivateKey, generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";
import {
  getGitHubConfigStatus,
  getMissingGitHubEnvKeys,
  githubAppEnvKeys,
  normalizePrivateKey,
  resolveGitHubAppConfig,
} from "./config";

const app = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
};

const serverEnv = {
  NEXT_PUBLIC_APP_URL: "https://wallie.test",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "service-key",
  WALLIE_ENCRYPTION_KEY: "a".repeat(64),
};

describe("GitHub App private key normalization", () => {
  it("converts GitHub's PKCS#1 PEM to PKCS#8 without changing the key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs1 = privateKey.export({ format: "pem", type: "pkcs1" }).toString();
    const normalized = resolveGitHubAppConfig({
      ...serverEnv,
      ...app,
      GITHUB_APP_PRIVATE_KEY: pkcs1,
    }).privateKey;

    expect(normalized).toMatch(/^-----BEGIN PRIVATE KEY-----\n/);
    expect(createPrivateKey(normalized).export({ format: "pem", type: "pkcs1" }).toString()).toBe(
      pkcs1,
    );
  });

  it("accepts escaped newlines and leaves PKCS#8 keys unchanged", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pkcs8 = privateKey.export({ format: "pem", type: "pkcs8" }).toString();

    expect(normalizePrivateKey(pkcs8.replaceAll("\n", "\\n"))).toBe(pkcs8);
  });
});

describe("GitHub configuration gates", () => {
  it("requires OAuth credentials for new installations while preserving App-only refresh and webhook configuration", () => {
    expect(getGitHubConfigStatus(app)).toEqual({
      missingAppKeys: ["GITHUB_APP_CLIENT_ID", "GITHUB_APP_CLIENT_SECRET"],
      missingWebhookKeys: [],
    });
    expect(getMissingGitHubEnvKeys(githubAppEnvKeys, app)).toEqual([]);
  });
  it("enables new connections only when both OAuth credentials are present", () => {
    expect(
      getGitHubConfigStatus({
        ...app,
        GITHUB_APP_CLIENT_ID: "client-id",
        GITHUB_APP_CLIENT_SECRET: " ",
      }).missingAppKeys,
    ).toEqual(["GITHUB_APP_CLIENT_SECRET"]);
    expect(
      getGitHubConfigStatus({
        ...app,
        GITHUB_APP_CLIENT_ID: "client-id",
        GITHUB_APP_CLIENT_SECRET: "client-secret",
      }).missingAppKeys,
    ).toEqual([]);
  });
});
