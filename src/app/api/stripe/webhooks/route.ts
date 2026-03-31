import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { parseServerEnv } from "@/env/server";
import {
  applyStripeSubscriptionUpdate,
  createStripeClient,
  getStripeConfigStatus,
} from "@/lib/billing/stripe";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

async function handleCheckoutSessionCompleted(
  session: Stripe.Checkout.Session,
) {
  const customerId =
    typeof session.customer === "string" ? session.customer : session.customer?.id;
  const workspaceId =
    typeof session.client_reference_id === "string"
      ? session.client_reference_id
      : null;

  if (!customerId || !workspaceId) {
    return;
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin
    .from("workspaces")
    .update({
      stripe_customer_id: customerId,
    })
    .eq("id", workspaceId);

  if (error) {
    throw error;
  }
}

export async function POST(request: Request) {
  const signature = request.headers.get("stripe-signature");
  const rawBody = await request.text();

  if (!signature) {
    return NextResponse.json(
      {
        error: "Stripe webhook signature is missing.",
      },
      { status: 400 },
    );
  }

  const missingKeys = getStripeConfigStatus().missingWebhookKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "Stripe webhook handling is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const stripe = createStripeClient();
  const env = parseServerEnv();
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      env.STRIPE_WEBHOOK_SECRET!,
    );
  } catch {
    return NextResponse.json(
      {
        error: "Stripe webhook signature verification failed.",
      },
      { status: 400 },
    );
  }

  switch (event.type) {
    case "checkout.session.completed":
      await handleCheckoutSessionCompleted(
        event.data.object as Stripe.Checkout.Session,
      );
      break;
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
      await applyStripeSubscriptionUpdate(
        event.data.object as Stripe.Subscription,
      );
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
