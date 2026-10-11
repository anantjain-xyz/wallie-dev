"use client";

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

import type { Database } from "./database.types";

/** Authenticate the join before subscribing; the SDK maintains later token changes. */
export function subscribeAuthenticatedChannel(
  supabase: SupabaseClient<Database>,
  channel: RealtimeChannel,
  onStatus: (status: string, error?: unknown) => void,
) {
  let disposed = false;
  void (async () => {
    const { data, error } = await supabase.auth.getSession();
    if (disposed) return;
    if (error) throw error;
    if (!data.session) throw new Error("A signed-in session is required for realtime.");
    await supabase.realtime.setAuth(data.session.access_token);
    if (!disposed) channel.subscribe(onStatus);
  })().catch((error: unknown) => {
    if (!disposed) onStatus("CHANNEL_ERROR", error);
  });

  return () => {
    disposed = true;
    void supabase.removeChannel(channel);
  };
}
