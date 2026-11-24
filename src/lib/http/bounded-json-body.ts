export async function readBoundedJsonBytes(
  request: Request,
  maxBodyBytes: number,
  signal?: AbortSignal,
) {
  const contentType = request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, code: "unsupported_media_type" } as const;
  }
  return readBoundedRequestBytes(request, maxBodyBytes, signal);
}

export async function readBoundedRequestBytes(
  request: Request,
  maxBodyBytes: number,
  signal?: AbortSignal,
) {
  const length = request.headers.get("Content-Length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBodyBytes)) {
    return { ok: false, code: "request_too_large" } as const;
  }
  if (!request.body || signal?.aborted) return { ok: false, code: "invalid_request" } as const;

  const reader = request.body.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (signal?.aborted) return { ok: false, code: "invalid_request" } as const;
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) {
        cancel();
        return { ok: false, code: "request_too_large" } as const;
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.byteLength;
    }
    return { ok: true, bytes } as const;
  } catch {
    return { ok: false, code: "invalid_request" } as const;
  } finally {
    signal?.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export async function readBoundedJsonBody(request: Request, maxBodyBytes: number) {
  const raw = await readBoundedJsonBytes(request, maxBodyBytes);
  if (!raw.ok) return raw;
  try {
    const body: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw.bytes));
    return { ok: true, body } as const;
  } catch {
    return { ok: false, code: "invalid_request" } as const;
  }
}
