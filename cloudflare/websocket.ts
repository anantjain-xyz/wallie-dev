/** Browser-shaped outbound socket for SDKs in Workers, where connections are
 * established through fetch's Upgrade API rather than Node's ws constructor.
 */
export default class OutboundWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 0;
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  protocol = "";
  extensions = "";
  readonly url: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private socket?: WebSocket;
  private events = new EventTarget();
  private closing?: { code?: number; reason?: string };

  constructor(url: string | URL, protocols: string | string[] = []) {
    this.url = String(url);
    void this.connect(typeof protocols === "string" ? [protocols] : protocols);
  }

  addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.events.addEventListener(...args);
  }
  removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.events.removeEventListener(...args);
  }
  dispatchEvent(event: Event) {
    return this.events.dispatchEvent(event);
  }

  private async connect(protocols: string[]) {
    try {
      const url = new URL(this.url);
      if (!["ws:", "wss:"].includes(url.protocol) || url.username || url.password)
        throw new Error("Invalid socket URL.");
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      const response = await fetch(url, {
        headers: {
          Upgrade: "websocket",
          ...(protocols.length ? { "Sec-WebSocket-Protocol": protocols.join(", ") } : {}),
        },
        redirect: "manual",
      });
      const socket = response.webSocket;
      if (response.status !== 101 || !socket) {
        await response.body?.cancel();
        throw new Error("Socket upgrade failed.");
      }
      this.socket = socket;
      this.protocol = response.headers.get("Sec-WebSocket-Protocol") ?? "";
      socket.addEventListener("message", (event) => {
        const message = new MessageEvent("message", { data: event.data });
        this.onmessage?.(message);
        this.dispatchEvent(message);
      });
      socket.addEventListener("close", (event) => {
        if (this.readyState === this.CLOSED) return;
        this.readyState = this.CLOSED;
        const closed = new CloseEvent("close", {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        });
        this.onclose?.(closed);
        this.dispatchEvent(closed);
      });
      socket.addEventListener("error", () => this.fail());
      socket.accept();
      if (this.closing) {
        socket.close(this.closing.code, this.closing.reason);
        return;
      }
      this.readyState = this.OPEN;
      const opened = new Event("open");
      this.onopen?.(opened);
      this.dispatchEvent(opened);
    } catch {
      this.fail();
    }
  }

  private fail() {
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSED;
    // Browser sockets emit asynchronously. A fast rejected Upgrade must allow
    // an async SDK factory's caller to attach its listeners before failure.
    setTimeout(() => {
      const error = new Event("error");
      this.onerror?.(error);
      this.dispatchEvent(error);
      const closed = new CloseEvent("close", {
        code: 1006,
        reason: "Socket connection failed.",
        wasClean: false,
      });
      this.onclose?.(closed);
      this.dispatchEvent(closed);
    }, 0);
  }

  send(data: string | ArrayBuffer | ArrayBufferView) {
    if (this.readyState !== this.OPEN || !this.socket) throw new Error("Socket is not open.");
    this.socket.send(data);
  }
  close(code?: number, reason?: string) {
    this.closing = { code, reason };
    if (this.readyState === this.CLOSED) return;
    this.readyState = this.CLOSING;
    this.socket?.close(code, reason);
  }
}
