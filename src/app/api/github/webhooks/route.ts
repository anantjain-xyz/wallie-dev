import { NextResponse } from "next/server";

import {
  installationEventSchema,
  pullRequestEventSchema,
  githubDeliveryIdSchema,
  isGitHubVerificationEvent,
  verificationEventPayloadSchemas,
} from "@/features/github/webhook-payloads";

import { getGitHubConfigStatus } from "@/features/github/config";
import { captureGitHubAutomationPullRequest } from "@/features/github/pr-automation";
import {
  handleGitHubInstallationEvent,
  handleGitHubInstallationRepositoriesEvent,
  handleGitHubPullRequestEvent,
  handleGitHubVerificationEvent,
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

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return invalidPayload();
  }

  if (isGitHubVerificationEvent(eventName)) {
    const signal = verificationEventPayloadSchemas[eventName].safeParse(payload);
    const delivery = githubDeliveryIdSchema.safeParse(request.headers.get("x-github-delivery"));
    if (!signal.success || !delivery.success) return invalidPayload();
    if (eventName === "pull_request") {
      const parsed = pullRequestEventSchema.safeParse(payload);
      if (!parsed.success) return invalidPayload();

      const results = await Promise.allSettled([
        handleGitHubVerificationEvent(signal.data, delivery.data).then(() =>
          handleGitHubPullRequestEvent(parsed.data),
        ),
        captureGitHubAutomationPullRequest(payload, delivery.data),
      ]);
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
    } else {
      await handleGitHubVerificationEvent(signal.data, delivery.data);
    }
  }

  switch (eventName) {
    case "installation": {
      const parsed = installationEventSchema.safeParse(payload);
      if (!parsed.success) return invalidPayload();
      await handleGitHubInstallationEvent(parsed.data);
      break;
    }
    case "installation_repositories": {
      const parsed = installationEventSchema.safeParse(payload);
      if (!parsed.success) return invalidPayload();
      await handleGitHubInstallationRepositoriesEvent(parsed.data);
      break;
    }
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

function invalidPayload() {
  return NextResponse.json({ error: "Invalid GitHub webhook payload." }, { status: 400 });
}
