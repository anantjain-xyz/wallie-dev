import { describe, expect, it } from "vitest";
import { getGitHubConfigStatus, getMissingGitHubEnvKeys, githubAppEnvKeys } from "./config";

const app = {
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: "private-key",
  GITHUB_WEBHOOK_SECRET: "webhook-secret",
};

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
