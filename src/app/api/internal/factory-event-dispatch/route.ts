import { timingSafeEqual } from "node:crypto";

import { factoryEventDispatchRelayEnvSchema } from "@/env/cloudflare";
import { drainFactoryEventDeliveries } from "@/lib/factory-event-subscriptions/dispatch";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;

function relayResponse(status: number) {
  return new Response(null, { status, headers: { "Cache-Control": "no-store" } });
}

async function hasEmptyBody(request: Request) {
  const length = request.headers.get("Content-Length");
  if ((length !== null && length !== "0") || request.headers.has("Transfer-Encoding")) {
    return false;
  }
  if (!request.body) return true;

  // Next's Node adapter can provide an empty stream even for a bodyless POST.
  const reader = request.body.getReader();
  try {
    return (await reader.read()).done;
  } catch {
    return false;
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

export async function POST(request: Request) {
  const secret =
    factoryEventDispatchRelayEnvSchema.shape.WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET.safeParse(
      process.env.WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET,
    );
  if (!secret.success || !secret.data) return relayResponse(404);

  const supplied = Buffer.from(request.headers.get("Authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret.data}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return relayResponse(401);
  }
  if (request.url.includes("?") || !(await hasEmptyBody(request))) return relayResponse(400);

  try {
    await drainFactoryEventDeliveries(createSupabaseAdminClient());
    return relayResponse(204);
  } catch {
    console.warn("[factory-event-dispatch] relay batch will resume on maintenance");
    return relayResponse(503);
  }
}
