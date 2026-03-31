import { NextResponse } from "next/server";

import { parseServerEnv } from "@/env/server";
import {
  createStripePortalSessionSchema,
  type CreateStripePortalSessionResponse,
} from "@/lib/billing/contracts";
import {
  createStripeClient,
  ensureStripeCustomerIdForWorkspace,
  getStripeConfigStatus,
} from "@/lib/billing/stripe";
import { workspaceSettingsPath } from "@/lib/routes";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

export async function POST(request: Request) {
  const payload = await request.json().catch(() => null);
  const parsed = createStripePortalSessionSchema.safeParse(payload);

  if (!parsed.success) {
    const firstIssue = parsed.error.issues[0];

    return NextResponse.json(
      {
        error: firstIssue?.message ?? "Workspace id is invalid.",
      },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json(
      {
        error: access.error,
      },
      { status: access.status },
    );
  }

  const missingKeys = getStripeConfigStatus().missingPortalKeys;

  if (missingKeys.length > 0) {
    return NextResponse.json(
      {
        code: "missing_config",
        error: "Stripe customer portal is unavailable until server config is complete.",
        missing: missingKeys,
      },
      { status: 503 },
    );
  }

  const env = parseServerEnv();
  const stripe = createStripeClient();
  const customerId = await ensureStripeCustomerIdForWorkspace(access.context.workspace);
  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: new URL(
      workspaceSettingsPath(access.context.workspace.slug, {
        billing: "returned",
      }),
      env.NEXT_PUBLIC_APP_URL,
    ).toString(),
  });
  const response: CreateStripePortalSessionResponse = {
    url: session.url,
  };

  return NextResponse.json(response, { status: 200 });
}
