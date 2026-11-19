import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { parseFactoryEventDestination } from "./destination";
import { postToFactoryEventDestination, proveFactoryEventDestination } from "./transport";

const mocked = vi.hoisted(() => ({
  resolve4: vi.fn(),
  resolve6: vi.fn(),
  connect: vi.fn(),
  request: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4 = mocked.resolve4;
    resolve6 = mocked.resolve6;
    cancel() {}
  },
}));
vi.mock("node:tls", async (original) => ({
  ...(await original<typeof import("node:tls")>()),
  connect: mocked.connect,
}));
vi.mock("node:https", () => ({ request: mocked.request }));

const url = "https://receiver.example/hooks?mode=wallie";
const challenge = "A".repeat(43);

class PeerSocket extends EventEmitter {
  remoteAddress = "8.8.4.4";
  remotePort = 443;
  authorized = true;
  destroyed = false;

  destroy() {
    if (!this.destroyed) {
      this.destroyed = true;
      this.emit("close");
    }
  }
}

function receiver(statusCode: number, headers: Record<string, string> = {}) {
  const closeResponse = vi.fn();
  const end = vi.fn();
  const outbound = Object.assign(new EventEmitter(), { end });
  mocked.request.mockImplementation((_options, response) => {
    end.mockImplementation(() => response({ statusCode, headers, destroy: closeResponse }));
    return outbound;
  });
  return { closeResponse, end, outbound };
}

describe("factory event destinations", () => {
  it("canonicalizes a regular HTTPS receiver while preserving its target path and query", () => {
    expect(parseFactoryEventDestination("https://RECEIVER.Example:443/hooks?mode=wallie")).toBe(
      url,
    );
  });

  it.each([
    "http://receiver.example/",
    "https://receiver.example:8443/",
    "https://127.1/",
    "https://2130706433/",
    "https://[::1]/",
    "https://.receiver.example/",
    "https://@receiver.example/",
    "https://user:password@receiver.example/",
    "https://receiver.example/#",
    "https://receiver.example\\@example.org/",
    "https://receiver.example/\nhello",
    "https://metadata.google.internal/",
    "https://receiver.localhost/",
  ])("rejects %s", (target) => {
    expect(parseFactoryEventDestination(target)).toBeNull();
  });
});

describe("pinned HTTPS delivery", () => {
  let peer: PeerSocket;

  beforeEach(() => {
    vi.resetAllMocks();
    peer = new PeerSocket();
    mocked.resolve4.mockResolvedValue([peer.remoteAddress]);
    mocked.resolve6.mockResolvedValue([]);
    mocked.connect.mockImplementation(() => {
      queueMicrotask(() => peer.emit("secureConnect"));
      return peer;
    });
  });

  it.each([
    ["127.0.0.1", 4],
    ["10.1.2.3", 4],
    ["100.100.100.200", 4],
    ["168.63.129.16", 4],
    ["169.254.169.254", 4],
    ["192.168.1.9", 4],
    ["::ffff:127.0.0.1", 6],
    ["fd00:ec2::254", 6],
    ["64:ff9b::7f00:1", 6],
    ["2002:7f00:1::", 6],
    ["fe80::1", 6],
    ["3fff::1", 6],
  ])("rejects mixed public and blocked DNS answers containing %s", async (address, family) => {
    if (family === 4) mocked.resolve4.mockResolvedValue([peer.remoteAddress, address]);
    else mocked.resolve6.mockResolvedValue([address]);
    const prepare = vi.fn();
    await expect(postToFactoryEventDestination({ url, prepare })).resolves.toEqual({
      kind: "rejected",
    });
    expect(mocked.connect).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("resolves both record families and pins validated SNI and peer before taking the permit", async () => {
    const payload = Promise.withResolvers<{ body: string }>();
    const prepare = vi.fn(() => payload.promise);
    const endpoint = receiver(302, { location: "https://another.example/private" });
    const delivery = postToFactoryEventDestination({ url, prepare });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    expect(mocked.resolve4).toHaveBeenCalledExactlyOnceWith("receiver.example.");
    expect(mocked.resolve6).toHaveBeenCalledExactlyOnceWith("receiver.example.");
    expect(mocked.connect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        host: "8.8.4.4",
        port: 443,
        servername: "receiver.example",
        rejectUnauthorized: true,
        checkServerIdentity: expect.any(Function),
      }),
    );
    expect(mocked.request).not.toHaveBeenCalled();
    payload.resolve({ body: '{"type":"session.created"}' });
    await expect(delivery).resolves.toMatchObject({ kind: "response", status: 302 });
    expect(mocked.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ hostname: "receiver.example", path: "/hooks?mode=wallie" }),
      expect.any(Function),
    );
    expect(mocked.request.mock.lastCall?.[0].createConnection()).toBe(peer);
    expect(endpoint.end).toHaveBeenCalledExactlyOnceWith('{"type":"session.created"}');
    expect(endpoint.closeResponse).toHaveBeenCalledOnce();
    expect(peer.destroyed).toBe(true);

    mocked.resolve4.mockResolvedValue(["169.254.169.254"]);
    await expect(postToFactoryEventDestination({ url, prepare })).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(mocked.resolve4).toHaveBeenCalledTimes(2);
    expect(mocked.resolve6).toHaveBeenCalledTimes(2);
    expect(mocked.connect).toHaveBeenCalledOnce();
    expect(mocked.request).toHaveBeenCalledOnce();
  });

  it("does not trust the other address family when DNS failed rather than returning no records", async () => {
    mocked.resolve6.mockRejectedValue({ code: "ETIMEOUT" });
    await expect(postToFactoryEventDestination({ url, prepare: vi.fn() })).resolves.toMatchObject({
      kind: "unavailable",
    });
    expect(mocked.connect).not.toHaveBeenCalled();
  });

  it("pins an IPv6-only receiver when the IPv4 lookup has no records", async () => {
    const address = "2606:4700:0:0:0:0:0:1111";
    peer.remoteAddress = "2606:4700::1111";
    mocked.resolve4.mockRejectedValue({ code: "ENODATA" });
    mocked.resolve6.mockResolvedValue([address]);
    receiver(204);
    await expect(
      postToFactoryEventDestination({ url, prepare: async () => ({ body: "{}" }) }),
    ).resolves.toMatchObject({ kind: "response", status: 204 });
    expect(mocked.connect).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ host: address, servername: "receiver.example" }),
    );
  });

  it("blocks a different connected peer before database permit or HTTP", async () => {
    peer.remoteAddress = "8.8.8.8";
    const prepare = vi.fn();
    await expect(postToFactoryEventDestination({ url, prepare })).resolves.toMatchObject({
      kind: "rejected",
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(mocked.request).not.toHaveBeenCalled();
    expect(peer.destroyed).toBe(true);
  });

  it("closes the connection without HTTP when the live permit was refused", async () => {
    await expect(
      postToFactoryEventDestination({ url, prepare: async () => null }),
    ).resolves.toMatchObject({ kind: "skipped" });
    expect(mocked.request).not.toHaveBeenCalled();
    expect(peer.destroyed).toBe(true);
  });

  it("reports a connection loss after submitting bytes as unknown", async () => {
    const endpoint = receiver(204);
    mocked.request.mockImplementation(() => endpoint.outbound);
    endpoint.end.mockImplementation(() => endpoint.outbound.emit("close"));
    await expect(
      postToFactoryEventDestination({ url, prepare: async () => ({ body: "{}" }) }),
    ).resolves.toMatchObject({ kind: "unknown" });
    expect(endpoint.end).toHaveBeenCalledExactlyOnceWith("{}");
    expect(peer.destroyed).toBe(true);
  });

  it("reports a deadline after submitting bytes as unknown and destroys the connection", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
    const endpoint = receiver(204);
    mocked.request.mockImplementation(({ signal }: { signal: AbortSignal }) => {
      signal.addEventListener("abort", () => endpoint.outbound.emit("error", signal.reason));
      return endpoint.outbound;
    });
    try {
      const delivery = postToFactoryEventDestination({
        url,
        prepare: async () => ({ body: "{}" }),
      });
      await vi.waitFor(() => expect(endpoint.end).toHaveBeenCalledOnce());
      deadline.abort();
      await expect(delivery).resolves.toMatchObject({ kind: "unknown" });
      expect(peer.destroyed).toBe(true);
    } finally {
      timeout.mockRestore();
    }
  });

  it.each([
    [202, challenge, true],
    [202, "wrong challenge", false],
    [302, challenge, false],
    [500, challenge, false],
  ])(
    "requires an exact ownership response header on 2xx, got %s",
    async (status, echoed, valid) => {
      const endpoint = receiver(status, { "wallie-verification": echoed });
      await expect(proveFactoryEventDestination({ url, challenge })).resolves.toBe(valid);
      expect(endpoint.end).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ type: "wallie.subscription.verification", challenge }),
      );
      expect(mocked.request.mock.lastCall?.[0].headers).not.toHaveProperty("Wallie-Signature");
    },
  );
});
