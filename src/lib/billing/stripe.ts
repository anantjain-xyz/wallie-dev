import Stripe from "stripe";

import { parseServerEnv } from "@/env/server";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import type { Tables } from "@/lib/supabase/database.types";

let stripeClientSingleton: Stripe | null = null;

export const stripePortalEnvKeys = ["STRIPE_SECRET_KEY"] as const;
export const stripeWebhookEnvKeys = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] as const;

export function getMissingStripeEnvKeys(
  keys: readonly string[],
  input: Record<string, string | undefined> = process.env,
) {
  return keys.filter((key) => !input[key]?.trim());
}

export function getStripeConfigStatus(
  input: Record<string, string | undefined> = process.env,
) {
  return {
    missingPortalKeys: getMissingStripeEnvKeys(stripePortalEnvKeys, input),
    missingWebhookKeys: getMissingStripeEnvKeys(stripeWebhookEnvKeys, input),
  };
}

export function createStripeClient(
  input: Record<string, string | undefined> = process.env,
) {
  if (stripeClientSingleton && input === process.env) {
    return stripeClientSingleton;
  }

  const env = parseServerEnv(input);

  if (!env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY is required.");
  }

  const client = new Stripe(env.STRIPE_SECRET_KEY);

  if (input === process.env) {
    stripeClientSingleton = client;
  }

  return client;
}

async function createStripeCustomerForWorkspace(
  stripe: Stripe,
  workspace: Pick<Tables<"workspaces">, "id" | "name" | "slug">,
) {
  return stripe.customers.create({
    metadata: {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
    },
    name: workspace.name,
  });
}

export async function ensureStripeCustomerIdForWorkspace(
  workspace: Pick<Tables<"workspaces">, "id" | "name" | "slug" | "stripe_customer_id">,
  input: Record<string, string | undefined> = process.env,
) {
  const stripe = createStripeClient(input);
  const admin = createSupabaseAdminClient(input);

  if (workspace.stripe_customer_id) {
    try {
      const customer = await stripe.customers.retrieve(workspace.stripe_customer_id);

      if (!("deleted" in customer && customer.deleted)) {
        return workspace.stripe_customer_id;
      }
    } catch {
      // Fall through and mint a new customer id when the stored customer no longer exists.
    }
  }

  const customer = await createStripeCustomerForWorkspace(stripe, workspace);
  const { error } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customer.id,
    })
    .eq("id", workspace.id);

  if (error) {
    throw error;
  }

  return customer.id;
}

function resolveWorkspaceTierForSubscription(
  status: Stripe.Subscription.Status,
) {
  switch (status) {
    case "active":
    case "trialing":
    case "past_due":
    case "unpaid":
      return "pro" as const;
    default:
      return "free" as const;
  }
}

function resolveSubscriptionCycleStart(
  subscription: Stripe.Subscription,
) {
  const lineItem = subscription.items.data[0];

  return (
    lineItem?.current_period_start ??
    subscription.trial_start ??
    subscription.created
  );
}

async function findWorkspaceByStripeCustomerId(
  customerId: string,
  input: Record<string, string | undefined> = process.env,
) {
  const admin = createSupabaseAdminClient(input);
  const { data, error } = await admin
    .from("workspaces")
    .select(
      "id, name, slug, tier, stripe_customer_id, current_billing_cycle_start_at, successful_agent_runs_this_cycle",
    )
    .eq("stripe_customer_id", customerId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

async function inferWorkspaceIdFromStripeCustomer(
  customerId: string,
  input: Record<string, string | undefined> = process.env,
) {
  const stripe = createStripeClient(input);
  const customer = await stripe.customers.retrieve(customerId);

  if ("deleted" in customer && customer.deleted) {
    return null;
  }

  const workspaceId = customer.metadata.workspaceId;

  if (!workspaceId) {
    return null;
  }

  const admin = createSupabaseAdminClient(input);
  const { data, error } = await admin
    .from("workspaces")
    .select(
      "id, name, slug, tier, stripe_customer_id, current_billing_cycle_start_at, successful_agent_runs_this_cycle",
    )
    .eq("id", workspaceId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  if (!data) {
    return null;
  }

  if (data.stripe_customer_id !== customerId) {
    const { error: updateError } = await admin
      .from("workspaces")
      .update({
        stripe_customer_id: customerId,
      })
      .eq("id", workspaceId);

    if (updateError) {
      throw updateError;
    }

    return {
      ...data,
      stripe_customer_id: customerId,
    };
  }

  return data;
}

export async function applyStripeSubscriptionUpdate(
  subscription: Stripe.Subscription,
  input: Record<string, string | undefined> = process.env,
) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;

  let workspace = await findWorkspaceByStripeCustomerId(customerId, input);

  if (!workspace) {
    workspace = await inferWorkspaceIdFromStripeCustomer(customerId, input);
  }

  if (!workspace) {
    return null;
  }

  const admin = createSupabaseAdminClient(input);
  const nextTier = resolveWorkspaceTierForSubscription(subscription.status);
  const cycleStartIso = new Date(
    resolveSubscriptionCycleStart(subscription) * 1000,
  ).toISOString();
  const shouldResetRunCounter =
    cycleStartIso !== workspace.current_billing_cycle_start_at ||
    nextTier === "free";

  const { data, error } = await admin
    .from("workspaces")
    .update({
      current_billing_cycle_start_at: cycleStartIso,
      stripe_customer_id: customerId,
      successful_agent_runs_this_cycle: shouldResetRunCounter
        ? 0
        : workspace.successful_agent_runs_this_cycle,
      tier: nextTier,
    })
    .eq("id", workspace.id)
    .select(
      "id, name, slug, tier, stripe_customer_id, current_billing_cycle_start_at, successful_agent_runs_this_cycle",
    )
    .single();

  if (error) {
    throw error;
  }

  return data;
}
