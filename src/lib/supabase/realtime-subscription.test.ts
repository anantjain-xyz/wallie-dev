import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import type { Database } from "./database.types";
import { subscribeAuthenticatedChannel } from "./realtime-subscription";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function setup() {
  const session = deferred<{
    data: { session: { access_token: string } | null };
    error: Error | null;
  }>();
  const authenticated = deferred<void>();
  const client = {
    auth: { getSession: vi.fn(() => session.promise) },
    realtime: { setAuth: vi.fn(() => authenticated.promise) },
    removeChannel: vi.fn(),
  };
  const channel = { subscribe: vi.fn() };
  const status = vi.fn();
  const stop = subscribeAuthenticatedChannel(
    client as unknown as SupabaseClient<Database>,
    channel as unknown as RealtimeChannel,
    status,
  );
  return { authenticated, channel, client, session, status, stop };
}

const signedIn = { data: { session: { access_token: "current-session-token" } }, error: null };

describe("authenticated realtime subscription", () => {
  it("waits for the current session and realtime authentication before joining", async () => {
    const { authenticated, channel, client, session, status } = setup();
    expect(channel.subscribe).not.toHaveBeenCalled();
    session.resolve(signedIn);
    await vi.waitFor(() =>
      expect(client.realtime.setAuth).toHaveBeenCalledWith("current-session-token"),
    );
    expect(channel.subscribe).not.toHaveBeenCalled();
    authenticated.resolve();
    await vi.waitFor(() => expect(channel.subscribe).toHaveBeenCalledWith(status));
  });

  it("reports a missing session to recovery instead of joining anonymously", async () => {
    const { channel, client, session, status } = setup();
    session.resolve({ data: { session: null }, error: null });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("CHANNEL_ERROR", expect.any(Error)));
    expect(client.realtime.setAuth).not.toHaveBeenCalled();
    expect(channel.subscribe).not.toHaveBeenCalled();
  });

  it("reports session loading failures to recovery", async () => {
    const { channel, session, status } = setup();
    const error = new Error("Session unavailable");
    session.resolve({ data: { session: null }, error });
    await vi.waitFor(() => expect(status).toHaveBeenCalledWith("CHANNEL_ERROR", error));
    expect(channel.subscribe).not.toHaveBeenCalled();
  });

  it("does not authenticate or join a subscription disposed while loading its session", async () => {
    const { channel, client, session, status, stop } = setup();
    stop();
    session.resolve(signedIn);
    await session.promise;
    expect(client.removeChannel).toHaveBeenCalledWith(channel);
    expect(client.realtime.setAuth).not.toHaveBeenCalled();
    expect(channel.subscribe).not.toHaveBeenCalled();
    expect(status).not.toHaveBeenCalled();
  });

  it("does not join a subscription disposed while authenticating", async () => {
    const { authenticated, channel, client, session, stop } = setup();
    session.resolve(signedIn);
    await vi.waitFor(() => expect(client.realtime.setAuth).toHaveBeenCalledOnce());
    stop();
    authenticated.resolve();
    await authenticated.promise;
    expect(channel.subscribe).not.toHaveBeenCalled();
  });
});
