import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const createClient = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient }));

type Probe = (options: {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
  signal?: AbortSignal;
}) => Promise<unknown>;
let probe: Probe;

beforeAll(async () => {
  const helper = new URL(
    "../../../scripts/fixtures/self-hosted-supabase-probe.mjs",
    import.meta.url,
  ).href;
  ({ checkSelfHostedSupabase: probe } = await import(helper));
});

beforeEach(() => {
  createClient.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejectedPromptly(promise: Promise<unknown>, reason: unknown) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      promise.then(
        () => ({ kind: "resolved" }),
        (error: unknown) => ({ kind: "rejected", error }),
      ),
      new Promise<{ kind: string }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: "timeout" }), 1_000);
      }),
    ]);
    expect(result.kind).toBe("rejected");
    expect("error" in result ? result.error : undefined).toBe(reason);
  } finally {
    clearTimeout(timer);
  }
}

function setup() {
  const controller = new AbortController();
  const options = {
    url: "http://127.0.0.1:54321",
    anonKey: "test-anon",
    serviceRoleKey: "test-service",
    signal: controller.signal,
  };
  const subscribed = deferred<void>();
  const updated = deferred<void>();
  const leave = deferred<void>();
  const listeners = new Map<string, (payload: Record<string, unknown>) => void>();
  const channel = {
    teardown: vi.fn(),
    on: vi.fn(
      (event: string, _filter: unknown, callback: (payload: Record<string, unknown>) => void) => {
        listeners.set(event, callback);
        return channel;
      },
    ),
    subscribe: vi.fn((callback: (status: string) => void) => {
      callback("SUBSCRIBED");
      subscribed.resolve();
      return channel;
    }),
  };
  const cleanup = vi.fn(() => Promise.resolve({ data: null, error: null }));
  const storage = vi.fn(() => {
    throw new Error("Storage must not run after cancellation");
  });
  const update = vi.fn(() => {
    updated.resolve();
    return {
      eq: () => ({
        select: () => ({ single: () => ({ data: { id: "workspace-0" }, error: null }) }),
      }),
    };
  });
  let created = 0;
  let clientIndex = -1;
  let requestFetch: typeof fetch;
  const users = [0, 1].map((index) => ({
    auth: {
      signInWithPassword: vi.fn(async () => ({
        data: { user: { id: `user-${index}` }, session: { access_token: "test-token" } },
        error: null,
      })),
      signOut: cleanup,
    },
    rpc: vi.fn(async (_name: string, args: { actor_full_name: string }) => ({
      data: { id: `user-${index}`, full_name: args.actor_full_name },
      error: null,
    })),
    from: vi.fn(() => ({
      select: () => ({
        in: () => ({ data: [{ id: `workspace-${index}` }], error: null }),
        eq: () => ({ data: [], error: null }),
      }),
    })),
    channel: vi.fn(() => channel),
    removeChannel: vi.fn(() => leave.promise),
    realtime: { disconnect: vi.fn(() => leave.promise) },
    storage: { from: storage },
  }));
  const admin = {
    auth: {
      admin: {
        createUser: vi.fn(async () => ({
          data: { user: { id: `user-${created++}` } },
          error: null,
        })),
        deleteUser: cleanup,
      },
    },
    rpc: vi.fn(async (_name: string, args: { actor_user_id: string }) => ({
      data: { id: `workspace-${args.actor_user_id.slice(-1)}` },
      error: null,
    })),
    from: vi.fn(() => ({ update, delete: cleanup })),
    storage: { from: storage },
  };
  createClient.mockImplementation((_url, _key, clientOptions) => {
    requestFetch = clientOptions.global.fetch;
    return clientIndex++ === -1 ? admin : users[clientIndex - 1];
  });
  return {
    options,
    controller,
    users,
    admin,
    cleanup,
    storage,
    update,
    subscribed,
    updated,
    listeners,
    leave,
    channel,
    fetch: (...args: Parameters<typeof fetch>) => requestFetch(...args),
  };
}

describe("self-hosted service probe cancellation", () => {
  it("rejects an already-aborted run before creating any clients or requests", async () => {
    const fixture = setup();
    const fetch = vi.fn(() => {
      throw new Error("Unexpected network request");
    });
    vi.stubGlobal("fetch", fetch);
    fixture.controller.abort(new Error("Stop qualification"));
    await rejectedPromptly(probe(fixture.options), fixture.controller.signal.reason);
    expect(createClient).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("aborts an in-flight HTTP request and skips remaining probes and API cleanup", async () => {
    const fixture = setup();
    const entered = deferred<AbortSignal>();
    const fetch = vi.fn(
      (_url, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          entered.resolve(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    vi.stubGlobal("fetch", fetch);
    fixture.users[0].auth.signInWithPassword.mockImplementation(async () => {
      await fixture.fetch("http://127.0.0.1:54321/auth/v1/token");
      throw new Error("The cancelled request must not complete");
    });
    const pending = probe(fixture.options);
    const requestSignal = await entered.promise;
    fixture.controller.abort(new Error("Stop qualification"));
    await rejectedPromptly(pending, fixture.controller.signal.reason);
    expect(requestSignal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fixture.admin.auth.admin.createUser).toHaveBeenCalledTimes(1);
    expect(fixture.users[0].rpc).not.toHaveBeenCalled();
    expect(fixture.cleanup).not.toHaveBeenCalled();
    expect(fixture.storage).not.toHaveBeenCalled();
  });

  it.each(["listener readiness", "published update"])(
    "aborts the Realtime %s wait without awaiting a leave acknowledgement",
    async (phase) => {
      const fixture = setup();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => {
          throw new Error("Unexpected network request");
        }),
      );
      const pending = probe(fixture.options);
      try {
        await fixture.subscribed.promise;
        expect(fixture.update).not.toHaveBeenCalled();
        if (phase === "published update") {
          fixture.listeners.get("system")!({ extension: "postgres_changes", status: "ok" });
          await fixture.updated.promise;
        }
        fixture.controller.abort(new Error("Stop qualification"));
        await rejectedPromptly(pending, fixture.controller.signal.reason);
        expect(fixture.channel.teardown).toHaveBeenCalledOnce();
        expect(fixture.users[0].realtime.disconnect).toHaveBeenCalled();
        expect(fixture.cleanup).not.toHaveBeenCalled();
        expect(fixture.storage).not.toHaveBeenCalled();
        fixture.listeners.get("system")!({ extension: "postgres_changes", status: "ok" });
        expect(fixture.update).toHaveBeenCalledTimes(phase === "published update" ? 1 : 0);
      } finally {
        fixture.leave.resolve();
      }
    },
  );
});
