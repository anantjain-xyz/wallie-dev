import "server-only";

import { Resolver } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";
import { checkServerIdentity, connect, type TLSSocket } from "node:tls";

import { parseFactoryEventDestination } from "./destination";

const requestTimeoutMs = 8_000;
const maxBodyBytes = 16_384;
const maxHeaderBytes = 8_192;

// Deny special-purpose ranges as well as private, multicast, and reserved networks.
const blockedAddresses = new BlockList();
const v4ReservedNetworks: [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["168.63.129.16", 32],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 3],
];
const v6ReservedNetworks: [string, number][] = [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3fff::", 20],
];
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of v4ReservedNetworks) blockedAddresses.addSubnet(network, prefix);
for (const [network, prefix] of v6ReservedNetworks) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

type Peer = { address: string; family: 4 | 6 };
type TransportFailure =
  | { kind: "rejected" }
  | { kind: "unavailable" }
  | { kind: "unknown" }
  | { kind: "skipped" };
export type FactoryEventTransportResult =
  | TransportFailure
  | { kind: "response"; status: number; retryAfter?: string; verification?: string };

type Message = { body: string; headers?: Record<string, string> };

function systemErrorCode(error: unknown) {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
}

function isPublicPeer({ address, family }: Peer) {
  if (isIP(address) !== family) return false;
  return family === 4
    ? !blockedAddresses.check(address)
    : globalV6.check(address, "ipv6") && !blockedAddresses.check(address, "ipv6");
}

async function resolvePublicPeer(hostname: string, signal: AbortSignal) {
  const resolver = new Resolver({ timeout: 1_200, tries: 2 });
  const cancel = () => resolver.cancel();
  signal.addEventListener("abort", cancel, { once: true });
  const resolveFamily = async (family: 4 | 6): Promise<Peer[]> => {
    try {
      const qualifiedName = `${hostname}.`;
      const addresses = await (family === 4
        ? resolver.resolve4(qualifiedName)
        : resolver.resolve6(qualifiedName));
      return addresses.map((address) => ({ address, family }));
    } catch (error) {
      if (systemErrorCode(error) === "ENODATA") return [];
      throw error;
    }
  };

  try {
    if (signal.aborted) return { kind: "unavailable" } as const;
    const [v4, v6] = await Promise.all([resolveFamily(4), resolveFamily(6)]);
    const peers = [...v4, ...v6];
    if (peers.length > 64 || !peers.every(isPublicPeer)) return { kind: "rejected" } as const;
    const peer = peers[0];
    return peer ? ({ kind: "resolved", peer } as const) : ({ kind: "unavailable" } as const);
  } catch {
    return { kind: "unavailable" } as const;
  } finally {
    resolver.cancel();
    signal.removeEventListener("abort", cancel);
  }
}

function matchesPeer(socket: TLSSocket, peer: Peer) {
  const remote = socket.remoteAddress;
  if (!remote || socket.remotePort !== 443 || isIP(remote) !== peer.family) return false;
  if (peer.family === 4) return remote === peer.address;
  return new URL(`https://[${remote}]`).hostname === new URL(`https://[${peer.address}]`).hostname;
}

function connectPinnedPeer({
  hostname,
  peer,
  signal,
}: {
  hostname: string;
  peer: Peer;
  signal: AbortSignal;
}): Promise<{ kind: "connected"; socket: TLSSocket } | TransportFailure> {
  return new Promise((resolve) => {
    const socket = connect({
      host: peer.address,
      port: 443,
      servername: hostname,
      rejectUnauthorized: true,
      checkServerIdentity: (_server, cert) => checkServerIdentity(hostname, cert),
      minVersion: "TLSv1.2",
      ALPNProtocols: ["http/1.1"],
    });
    const cancel = () => socket.destroy();
    socket.on("error", (error) => {
      const code = systemErrorCode(error);
      resolve({
        kind: /CERT|^ERR_TLS_|^UNABLE_TO_VERIFY/.test(code) ? "rejected" : "unavailable",
      });
    });
    socket.once("close", () => {
      signal.removeEventListener("abort", cancel);
      resolve({ kind: "unavailable" });
    });
    socket.once("secureConnect", () => {
      if (!socket.authorized || !matchesPeer(socket, peer)) {
        resolve({ kind: "rejected" });
        socket.destroy();
      } else {
        resolve({ kind: "connected", socket });
      }
    });
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
  });
}

function sendPinnedRequest({
  socket,
  url,
  message,
  signal,
}: {
  socket: TLSSocket;
  url: URL;
  message: Message;
  signal: AbortSignal;
}): Promise<FactoryEventTransportResult> {
  return new Promise((resolve) => {
    const outbound = request(
      {
        hostname: url.hostname,
        port: 443,
        method: "POST",
        path: url.pathname + url.search,
        createConnection: () => socket,
        headers: {
          ...message.headers,
          Host: url.hostname,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(message.body),
          Connection: "close",
        },
        maxHeaderSize: maxHeaderBytes,
        signal,
      },
      (response) => {
        const { statusCode, headers } = response;
        resolve(
          typeof statusCode === "number" && statusCode >= 100 && statusCode <= 599
            ? {
                kind: "response",
                status: statusCode,
                retryAfter: headers["retry-after"],
                verification:
                  typeof headers["wallie-verification"] === "string"
                    ? headers["wallie-verification"]
                    : undefined,
              }
            : { kind: "unknown" },
        );
        // Only final response headers matter. Discard the receiver body and close this socket.
        response.destroy();
      },
    );
    outbound.once("upgrade", (response) => {
      resolve({ kind: "response", status: response.statusCode ?? 101 });
    });
    outbound.once("error", () => resolve({ kind: "unknown" }));
    outbound.once("close", () => resolve({ kind: "unknown" }));
    outbound.end(message.body);
  });
}

export async function postToFactoryEventDestination({
  url,
  prepare,
}: {
  url: string;
  prepare: (signal: AbortSignal) => Promise<Message | null>;
}): Promise<FactoryEventTransportResult> {
  const canonical = parseFactoryEventDestination(url);
  if (!canonical || canonical !== url) return { kind: "rejected" };
  const target = new URL(canonical);
  const deadline = performance.now() + requestTimeoutMs;
  const signal = AbortSignal.timeout(requestTimeoutMs);
  const resolved = await resolvePublicPeer(target.hostname, signal);
  if (resolved.kind !== "resolved") return resolved;
  const connection = await connectPinnedPeer({
    hostname: target.hostname,
    peer: resolved.peer,
    signal,
  });
  if (connection.kind !== "connected") return connection;

  const { socket } = connection;
  try {
    if (socket.destroyed || signal.aborted || performance.now() >= deadline) {
      return { kind: "unavailable" };
    }
    // Only the TLS handshake precedes the durable authorization. The exact
    // verified socket is reused and no application request is written until it permits.
    const message = await prepare(signal);
    if (!message) return { kind: "skipped" };
    if (Buffer.byteLength(message.body) > maxBodyBytes) return { kind: "rejected" };
    if (socket.destroyed || signal.aborted || performance.now() >= deadline) {
      return { kind: "unavailable" };
    }
    return await sendPinnedRequest({ socket, url: target, message, signal });
  } finally {
    socket.destroy();
  }
}

export async function proveFactoryEventDestination({
  url,
  challenge,
}: {
  url: string;
  challenge: string;
}): Promise<boolean> {
  if (!/^[a-zA-Z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(challenge)) return false;
  const response = await postToFactoryEventDestination({
    url,
    prepare: async () => ({
      body: JSON.stringify({ type: "wallie.subscription.verification", challenge }),
    }),
  });
  return (
    response.kind === "response" &&
    response.status >= 200 &&
    response.status < 300 &&
    response.verification === challenge
  );
}
