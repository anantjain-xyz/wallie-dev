"use client";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import type { SupabasePublicConfig } from "./config";
import type { Database } from "./database.types";
import { subscribeAuthenticatedChannel } from "./realtime-subscription";

type BrowserClient = SupabaseClient<Database>;

export async function loadSupabaseBrowserClient(
  config: SupabasePublicConfig | null,
): Promise<BrowserClient> {
  const { createSupabaseBrowserClient } = await import("./browser");
  return createSupabaseBrowserClient(config);
}

export function subscribeDeferredAuthenticatedChannel(
  getClient: () => Promise<BrowserClient>,
  createChannel: (client: BrowserClient) => RealtimeChannel,
  onStatus: (status: string, error?: unknown) => void,
  isCurrent: () => boolean,
): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  const current = () => !disposed && isCurrent();
  void (async () => {
    const client = await getClient();
    if (!current()) return;
    const channel = createChannel(client);
    unsubscribe = subscribeAuthenticatedChannel(client, channel, (status, error) => {
      if (current()) onStatus(status, error);
    });
  })().catch((error: unknown) => {
    if (current()) onStatus("CHANNEL_ERROR", error);
  });

  return () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
  };
}
