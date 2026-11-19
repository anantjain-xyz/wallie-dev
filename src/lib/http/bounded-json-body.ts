export async function readBoundedJsonBody(request: Request, maxBodyBytes: number) {
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, code: "unsupported_media_type" } as const;
  }
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
    return { ok: false, code: "request_too_large" } as const;
  }
  if (!request.body) return { ok: false, code: "invalid_request" } as const;

  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const parts: string[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        void reader.cancel().catch(() => undefined);
        return { ok: false, code: "request_too_large" } as const;
      }
      parts.push(decoder.decode(value, { stream: true }));
    }
    parts.push(decoder.decode());
    const body: unknown = JSON.parse(parts.join(""));
    return { ok: true, body } as const;
  } catch {
    return { ok: false, code: "invalid_request" } as const;
  } finally {
    reader.releaseLock();
  }
}
