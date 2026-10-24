import { afterEach, expect, it, vi } from "vitest";
import OutboundWebSocket from "../websocket";
afterEach(() => vi.unstubAllGlobals());

it("uses native Upgrade fetch and forwards SDK socket events", async () => {
  const socket = Object.assign(new EventTarget(), {
    accept: vi.fn(),
    send: vi.fn(),
    close: vi.fn(),
  });
  const fetch = vi.fn().mockResolvedValue({
    status: 101,
    webSocket: socket,
    headers: new Headers({ "Sec-WebSocket-Protocol": "sdk-version" }),
  });
  vi.stubGlobal("fetch", fetch);
  const client = new OutboundWebSocket("wss://sandbox.example/logs?auth=synthetic", [
    "sdk-version",
  ]);
  const opened = vi.fn();
  const message = vi.fn();
  client.onopen = opened;
  client.onmessage = message;
  await new Promise<void>((resolve) =>
    client.addEventListener("open", () => resolve(), { once: true }),
  );
  expect(fetch).toHaveBeenCalledWith(
    new URL("https://sandbox.example/logs?auth=synthetic"),
    expect.objectContaining({
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": "sdk-version" },
      redirect: "manual",
    }),
  );
  expect(socket.accept).toHaveBeenCalledOnce();
  socket.dispatchEvent(new MessageEvent("message", { data: "live agent output" }));
  expect(message.mock.calls[0][0].data).toBe("live agent output");
  expect(message).toHaveBeenCalledOnce();
  client.send("input");
  expect(socket.send).toHaveBeenCalledWith("input");
  client.close(1000, "done");
  expect(socket.close).toHaveBeenCalledWith(1000, "done");
  expect(opened).toHaveBeenCalledOnce();
});

it("delivers an immediate Upgrade failure after an async SDK factory attaches listeners", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("synthetic connection failure")));
  const factory = async () => new OutboundWebSocket("wss://sandbox.example/logs");
  const client = await factory();
  const errors = vi.fn();
  const closed = vi.fn();
  client.addEventListener("error", errors);
  client.onclose = closed;
  await new Promise<void>((resolve) =>
    client.addEventListener("close", () => resolve(), { once: true }),
  );
  expect(errors).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledOnce();
  expect(client.readyState).toBe(client.CLOSED);
});
