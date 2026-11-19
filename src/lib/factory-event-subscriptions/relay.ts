import "server-only";

import { factoryEventDispatchRelayEnvSchema } from "@/env/cloudflare";

export async function requestFactoryEventDispatch(env: unknown) {
  const config = factoryEventDispatchRelayEnvSchema.safeParse(env);
  if (!config.success) throw new Error("Invalid event dispatch relay configuration.");
  const {
    WALLIE_FACTORY_EVENT_DISPATCH_RELAY_URL: url,
    WALLIE_FACTORY_EVENT_DISPATCH_RELAY_SECRET: secret,
  } = config.data;
  if (!url && !secret) return;
  if (!url || !secret) throw new Error("The event dispatch relay is unavailable.");

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      redirect: "error",
      signal: AbortSignal.timeout(55_000),
    });
    await response.body?.cancel();
    if (response.status === 204) return;
  } catch {
    // Delivery and recovery state remains durable in the Node sender's outbox.
  }
  throw new Error("The event dispatch relay could not complete.");
}
