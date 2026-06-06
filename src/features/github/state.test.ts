import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createGitHubInstallState, verifyGitHubInstallState } from "@/features/github/state";
import { verifyGitHubWebhookRequest } from "@/features/github/webhooks";

const testEnv = {
  GITHUB_APP_ID: "12345",
  GITHUB_APP_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
  GITHUB_WEBHOOK_SECRET: "github-webhook-secret",
  NEXT_PUBLIC_APP_URL: "https://www.wallie.dev",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "supabase-publishable-key",
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "secret-key",
  WALLIE_ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
};

describe("github install state", () => {
  it("round-trips a signed install state payload", () => {
    const token = createGitHubInstallState(
      {
        userId: "user-123",
        workspaceId: "workspace-123",
        workspaceSlug: "northwind-labs",
      },
      testEnv,
    );

    expect(verifyGitHubInstallState(token, testEnv)).toMatchObject({
      source: "settings",
      userId: "user-123",
      version: 1,
      workspaceId: "workspace-123",
      workspaceSlug: "northwind-labs",
    });
  });

  it("preserves onboarding install state source", () => {
    const token = createGitHubInstallState(
      {
        source: "onboarding",
        userId: "user-123",
        workspaceId: "workspace-123",
        workspaceSlug: "northwind-labs",
      },
      testEnv,
    );

    expect(verifyGitHubInstallState(token, testEnv)).toMatchObject({
      source: "onboarding",
      workspaceId: "workspace-123",
    });
  });

  it("rejects a tampered install state payload", () => {
    const token = createGitHubInstallState(
      {
        userId: "user-123",
        workspaceId: "workspace-123",
        workspaceSlug: "northwind-labs",
      },
      testEnv,
    );
    const [payload, signature] = token.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({
        createdAt: new Date().toISOString(),
        userId: "user-123",
        version: 1,
        workspaceId: "workspace-456",
        workspaceSlug: "northwind-labs",
      }),
      "utf8",
    ).toString("base64url");

    expect(signature).toBeTruthy();
    expect(verifyGitHubInstallState(`${tamperedPayload}.${signature}`, testEnv)).toBeNull();
    expect(verifyGitHubInstallState(`${payload}.invalid`, testEnv)).toBeNull();
  });
});

describe("github webhook verification", () => {
  it("accepts a valid webhook signature and rejects an invalid one", async () => {
    const payload = JSON.stringify({
      action: "opened",
      installation: {
        id: 42,
      },
    });
    const validSignature = `sha256=${createHmac("sha256", testEnv.GITHUB_WEBHOOK_SECRET)
      .update(payload)
      .digest("hex")}`;

    await expect(verifyGitHubWebhookRequest(payload, validSignature, testEnv)).resolves.toBe(true);
    await expect(verifyGitHubWebhookRequest(payload, "sha256=deadbeef", testEnv)).resolves.toBe(
      false,
    );
  });
});
