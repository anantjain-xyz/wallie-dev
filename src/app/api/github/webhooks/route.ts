import { NextResponse } from "next/server";

import { getGitHubConfigStatus } from "@/features/github/config";
import {
  handleGitHubInstallationEvent,
  handleGitHubInstallationRepositoriesEvent,
  handleGitHubPullRequestEvent,
  verifyGitHubWebhookRequest,
} from "@/features/github/webhooks";

export async function POST(request: Request) {
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event");
  const rawBody = await request.text();

  if (!signature) {
    return NextResponse.json(
      {
        error: "GitHub webhook signature is missing.",
      },
      { status: 400 },
    );
  }

  const missingKeys = getGitHubConfigStatus().missingWebhookKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "GitHub webhook handling is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const isValid = await verifyGitHubWebhookRequest(rawBody, signature);

  if (!isValid) {
    return NextResponse.json(
      {
        error: "GitHub webhook signature verification failed.",
      },
      { status: 401 },
    );
  }

  const payload = JSON.parse(rawBody);

  switch (eventName) {
    case "installation":
      await handleGitHubInstallationEvent(payload);
      break;
    case "installation_repositories":
      await handleGitHubInstallationRepositoriesEvent(payload);
      break;
    case "pull_request":
      await handleGitHubPullRequestEvent(payload);
      break;
    default:
      break;
  }

  return NextResponse.json(
    {
      received: true,
    },
    { status: 200 },
  );
}
