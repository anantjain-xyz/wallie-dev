import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "./database.types";
import { subscribeDeferredAuthenticatedChannel } from "./deferred-browser";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function setup() {
  const client = {
    auth: {
      getSession: vi.fn().mockResolvedValue({
        data: { session: { access_token: "session-token" } },
        error: null,
      }),
    },
    realtime: { setAuth: vi.fn().mockResolvedValue(undefined) },
    removeChannel: vi.fn(),
  };
  const channel = { subscribe: vi.fn<(onStatus: (status: string) => void) => void>() };
  const loaded = deferred<SupabaseClient<Database>>();
  const createChannel = vi.fn(() => channel as unknown as RealtimeChannel);
  const onStatus = vi.fn();
  const isCurrent = vi.fn(() => true);
  const getClient = vi.fn(() => loaded.promise);
  const subscribe = () =>
    subscribeDeferredAuthenticatedChannel(getClient, createChannel, onStatus, isCurrent);
  return { client, channel, loaded, createChannel, onStatus, isCurrent, subscribe };
}

describe("deferred browser subscription", () => {
  it("waits for client loading and authenticated joining, then removes the channel once", async () => {
    const { client, channel, loaded, createChannel, onStatus, subscribe } = setup();
    const stop = subscribe();
    expect(createChannel).not.toHaveBeenCalled();
    loaded.resolve(client as unknown as SupabaseClient<Database>);
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledOnce());
    expect(client.realtime.setAuth).toHaveBeenCalledWith("session-token");
    const status = channel.subscribe.mock.calls[0][0] as (status: string) => void;
    status("SUBSCRIBED");
    expect(onStatus).toHaveBeenCalledWith("SUBSCRIBED", undefined);
    stop();
    stop();
    expect(client.removeChannel).toHaveBeenCalledExactlyOnceWith(channel);
    status("CLOSED");
    expect(onStatus).toHaveBeenCalledTimes(1);
  });

  it("does not create a channel after disposal while the client is loading", async () => {
    const { client, loaded, createChannel, onStatus, subscribe } = setup();
    const stop = subscribe();
    stop();
    loaded.resolve(client as unknown as SupabaseClient<Database>);
    await loaded.promise;
    expect(createChannel).not.toHaveBeenCalled();
    expect(client.auth.getSession).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("does not create a channel for a superseded recovery generation", async () => {
    const { client, loaded, createChannel, onStatus, isCurrent, subscribe } = setup();
    const stop = subscribe();
    isCurrent.mockReturnValue(false);
    loaded.resolve(client as unknown as SupabaseClient<Database>);
    await loaded.promise;
    expect(createChannel).not.toHaveBeenCalled();
    expect(onStatus).not.toHaveBeenCalled();
    stop();
  });

  it("reports loading failures to recovery and allows a later subscription attempt", async () => {
    const { client, channel, loaded, onStatus, subscribe } = setup();
    const stop = subscribe();
    const error = new Error("SDK load failed");
    loaded.reject(error);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("CHANNEL_ERROR", error));
    stop();
    const retry = subscribeDeferredAuthenticatedChannel(
      () => Promise.resolve(client as unknown as SupabaseClient<Database>),
      () => channel as unknown as RealtimeChannel,
      onStatus,
      () => true,
    );
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledOnce());
    retry();
    expect(client.removeChannel).toHaveBeenCalledExactlyOnceWith(channel);
  });

  it("ignores loading failures after disposal", async () => {
    const { loaded, onStatus, subscribe } = setup();
    const stop = subscribe();
    stop();
    loaded.reject(new Error("Late SDK failure"));
    await loaded.promise.catch(() => undefined);
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("reports channel creation failures without subscribing", async () => {
    const { client, loaded, createChannel, channel, onStatus, subscribe } = setup();
    const error = new Error("Channel unavailable");
    createChannel.mockImplementation(() => {
      throw error;
    });
    const stop = subscribe();
    loaded.resolve(client as unknown as SupabaseClient<Database>);
    await vi.waitFor(() => expect(onStatus).toHaveBeenCalledWith("CHANNEL_ERROR", error));
    expect(channel.subscribe).not.toHaveBeenCalled();
    stop();
  });
});
