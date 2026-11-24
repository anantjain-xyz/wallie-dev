import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod/v4";

import { decryptSecretValue } from "@/lib/secrets/crypto";
import type { Database } from "@/lib/supabase/database.types";

import {
  slackAppIdSchema,
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "./contracts";
import { SlackProviderError, verifySlackChannel } from "./provider";

const claimSchema = z.object({
  queue_id: z.uuid(),
  lease_id: z.uuid(),
  team_id: slackTeamIdSchema,
  app_id: slackAppIdSchema,
  channel_id: slackChannelIdSchema,
  bot_user_id: slackUserIdSchema,
  encrypted_token: z.string().min(1),
  deadline_at: z.iso.datetime({ offset: true }),
});

type Claim = z.output<typeof claimSchema>;
type Client = Pick<SupabaseClient<Database>, "rpc">;
type MembershipResult =
  | { result: "verified" | "unavailable" }
  | { result: "retry"; retryAfterSeconds: number };
const defaultRetryAfterSeconds = 15;

function providerRetryAfterSeconds(response: Response): number {
  const delay = response.headers.get("Retry-After");
  return delay && /^\d+$/.test(delay)
    ? Math.max(1, Math.min(900, Number(delay)))
    : defaultRetryAfterSeconds;
}

async function verifyClaimChannel(claim: Claim, fetcher: typeof fetch): Promise<MembershipResult> {
  const remainingMs = Date.parse(claim.deadline_at) - Date.now();
  if (remainingMs <= 0) return { result: "unavailable" };

  let botAccessToken: string;
  try {
    botAccessToken = decryptSecretValue(claim.encrypted_token);
  } catch {
    return { result: "unavailable" };
  }
  const deadline = AbortSignal.timeout(Math.min(12_000, remainingMs));
  let retryAfterSeconds = defaultRetryAfterSeconds;
  try {
    await verifySlackChannel(
      {
        botAccessToken,
        botUserId: claim.bot_user_id,
        channelId: claim.channel_id,
        teamId: claim.team_id,
      },
      async (input, init) => {
        const response = await fetcher(input, {
          ...init,
          signal: init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline,
        });
        retryAfterSeconds = providerRetryAfterSeconds(response);
        return response;
      },
    );
    return { result: "verified" };
  } catch (error) {
    if (
      error instanceof SlackProviderError &&
      ["unavailable", "rate_limited", "membership_incomplete"].includes(error.reason)
    ) {
      return {
        result: "retry",
        retryAfterSeconds:
          error.reason === "rate_limited" ? retryAfterSeconds : defaultRetryAfterSeconds,
      };
    }
    return { result: "unavailable" };
  }
}

export async function drainSlackConnectorEvents(
  admin: Client,
  input: { workspaceId?: string; fetcher?: typeof fetch } = {},
) {
  for (let count = 0; count < 4; count++) {
    const { data, error } = await admin.rpc("claim_slack_connector_event", {
      ...(input.workspaceId ? { p_workspace_id: input.workspaceId } : {}),
    });
    if (error) throw new Error("Could not claim a Slack connector event.");
    const candidate = data[0];
    if (!candidate) return;
    const claim = claimSchema.parse(candidate);
    const outcome = await verifyClaimChannel(claim, input.fetcher ?? fetch);
    const settled = await admin.rpc("settle_slack_connector_event", {
      p_queue_id: claim.queue_id,
      p_lease_id: claim.lease_id,
      p_result: outcome.result,
      ...(outcome.result === "verified"
        ? {
            p_team_id: claim.team_id,
            p_app_id: claim.app_id,
            p_channel_id: claim.channel_id,
            p_bot_user_id: claim.bot_user_id,
          }
        : {}),
      ...(outcome.result === "retry" ? { p_retry_after_seconds: outcome.retryAfterSeconds } : {}),
    });
    if (settled.error) throw new Error("Could not settle a Slack connector event.");
  }
}
