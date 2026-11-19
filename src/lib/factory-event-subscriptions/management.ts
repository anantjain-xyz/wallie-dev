import "server-only";

import { createHash, randomBytes } from "node:crypto";

import { parseFactoryEventDestination } from "./destination";
import {
  factoryEventDeliveryCursor,
  type FactoryEventSubscriptionCommand,
} from "./management-contracts";
import { proveFactoryEventDestination } from "./transport";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { encryptSecretValue } from "@/lib/secrets/crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

type SubscriptionScope = {
  workspaceId: string;
  factoryId: string;
  actorUserId: string;
};

function actorParameters({ workspaceId, factoryId, actorUserId }: SubscriptionScope) {
  return { p_workspace_id: workspaceId, p_factory_id: factoryId, p_actor_user_id: actorUserId };
}

export class FactoryEventSubscriptionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function managerError(code: string | undefined, fallback: string) {
  const status = factoryErrorStatus(code);
  const text = status === 403 ? "Current factory authority is required." : fallback;
  return new FactoryEventSubscriptionError(status, text);
}

export async function loadFactoryEventSubscriptionSettings(scope: SubscriptionScope) {
  const admin = createSupabaseAdminClient();
  const actor = actorParameters(scope);
  const [subscriptions, authorizations] = await Promise.all([
    admin.rpc("list_factory_event_subscriptions", actor),
    admin.rpc("list_factory_event_authorizations", actor),
  ]);
  if (subscriptions.error || authorizations.error) {
    throw managerError(
      subscriptions.error?.code ?? authorizations.error?.code,
      "Could not load event subscriptions.",
    );
  }
  return { subscriptions: subscriptions.data, authorizations: authorizations.data };
}

export async function loadFactoryEventDeliveries(
  scope: SubscriptionScope,
  subscriptionId: string,
  cursor?: string,
) {
  const admin = createSupabaseAdminClient();
  const pageSize = 20;
  let before;
  if (cursor) {
    try {
      if (!/^[a-zA-Z0-9_-]{1,180}$/.test(cursor)) throw new Error();
      before = factoryEventDeliveryCursor.parse(
        JSON.parse(Buffer.from(cursor, "base64url").toString()),
      );
    } catch {
      throw new FactoryEventSubscriptionError(400, "Invalid delivery cursor.");
    }
  }
  const response = await admin.rpc("list_factory_event_deliveries", {
    ...actorParameters(scope),
    p_subscription_id: subscriptionId,
    p_limit: pageSize + 1,
    p_before_created_at: before?.beforeAt,
    p_before_id: before?.beforeId,
  });
  if (response.error) throw managerError(response.error.code, "Could not load event deliveries.");
  const deliveries = response.data.slice(0, pageSize);
  const last = response.data.length > pageSize ? deliveries.at(-1) : undefined;
  return {
    deliveries,
    nextCursor: last
      ? Buffer.from(JSON.stringify({ beforeAt: last.created_at, beforeId: last.id })).toString(
          "base64url",
        )
      : null,
  };
}

export async function executeFactoryEventSubscriptionCommand(
  scope: SubscriptionScope,
  command: FactoryEventSubscriptionCommand,
) {
  const admin = createSupabaseAdminClient();
  const actor = actorParameters(scope);
  switch (command.action) {
    case "create": {
      const destination = parseFactoryEventDestination(command.destination);
      if (!destination)
        throw new FactoryEventSubscriptionError(422, "Enter a public HTTPS endpoint.");
      const signingSecret = randomBytes(32).toString("base64url");
      const { data, error } = await admin.rpc("create_factory_event_subscription", {
        ...actor,
        p_name: command.name,
        p_endpoint_url: destination,
        p_credential_kind: command.credentialKind,
        p_credential_id: command.credentialId,
        p_event_types: command.eventTypes,
        p_signing_secret_encrypted: encryptSecretValue(signingSecret),
      });
      if (error || !data)
        throw managerError(error?.code, "Could not create the event subscription.");
      return { subscriptionId: data, signingSecret };
    }
    case "verify": {
      const challenge = randomBytes(32).toString("base64url");
      const digest = createHash("sha256").update(challenge).digest("hex");
      const args = {
        ...actor,
        p_subscription_id: command.subscriptionId,
        p_verification_digest: digest,
      };
      const { data, error } = await admin
        .rpc("begin_factory_event_subscription_verification", args)
        .maybeSingle();
      if (error || !data)
        throw managerError(error?.code, "Could not start verification. Wait before trying again.");
      if (!(await proveFactoryEventDestination({ url: data.endpoint_url, challenge }))) {
        throw new FactoryEventSubscriptionError(
          422,
          "The endpoint did not return the ownership challenge.",
        );
      }
      const confirmed = await admin.rpc("confirm_factory_event_subscription", args);
      if (confirmed.error)
        throw managerError(confirmed.error.code, "Could not activate the event subscription.");
      if (!confirmed.data)
        throw new FactoryEventSubscriptionError(
          409,
          "The subscription changed during verification.",
        );
      return { verified: true };
    }
    case "revoke": {
      const { data, error } = await admin.rpc("revoke_factory_event_subscription", {
        ...actor,
        p_subscription_id: command.subscriptionId,
      });
      if (error) throw managerError(error.code, "Could not revoke the event subscription.");
      if (!data)
        throw new FactoryEventSubscriptionError(404, "Active or pending subscription not found.");
      return { revoked: true };
    }
    case "retry": {
      const { data, error } = await admin.rpc("retry_factory_event_delivery", {
        ...actor,
        p_delivery_id: command.deliveryId,
      });
      if (error) throw managerError(error.code, "Could not retry the event delivery.");
      if (!data)
        throw new FactoryEventSubscriptionError(
          409,
          "This delivery is no longer eligible to retry.",
        );
      return { queued: true };
    }
  }
}
