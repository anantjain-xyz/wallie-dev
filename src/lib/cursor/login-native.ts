import "server-only";

/** Cursor SDK 1.0.30 login protocol, using Web Crypto and Connect's JSON encoding.
 * Browser launching, local credential stores, and agent execution are deliberately
 * outside this transport. Never include response bodies or auth URLs in errors.
 */
export const DEFAULT_LOGIN_API_KEY_TTL_MS = 7_776_000_000;
const BACKEND = "https://api2.cursor.sh";

export type CursorLoginInput = {
  apiKeyName: string;
  apiKeyTtlMs: number;
  onLoginUrl: (url: string) => void | Promise<void>;
  signal?: AbortSignal;
};

async function delay(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("Cursor sign-in canceled."));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function loginCursor(
  input: CursorLoginInput,
): Promise<{ apiKey: string; email?: string; apiKeyExpiresAtMs: number }> {
  input.signal?.throwIfAborted();
  if (!Number.isFinite(input.apiKeyTtlMs) || input.apiKeyTtlMs <= 0)
    throw new Error("Invalid Cursor API key lifetime.");
  const verifier = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
  const challenge = Buffer.from(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  ).toString("base64url");
  const uuid = crypto.randomUUID();
  await input.onLoginUrl(
    `https://cursor.com/loginDeepControl?challenge=${challenge}&uuid=${uuid}&mode=login&redirectTarget=sdk`,
  );
  let useGet = false;
  let checkedRoute = false;
  let failures = 0;
  let accessToken: string | undefined;
  for (let attempt = 0; attempt < 150; attempt++) {
    input.signal?.throwIfAborted();
    try {
      const response = await fetch(
        useGet
          ? `${BACKEND}/auth/poll?uuid=${uuid}&verifier=${encodeURIComponent(verifier)}`
          : `${BACKEND}/auth/poll`,
        {
          method: useGet ? "GET" : "POST",
          headers: {
            Accept: "application/json",
            ...(!useGet ? { "Content-Type": "application/json" } : {}),
          },
          ...(!useGet ? { body: JSON.stringify({ uuid, verifier }) } : {}),
          signal: input.signal,
          redirect: "manual",
        },
      );
      if (response.status === 404) {
        const text = (await response.text()).trim();
        if (!checkedRoute && !useGet && text !== "Not found") {
          useGet = true;
          continue;
        }
        if (useGet && /^\{"message":"Route \w+:/.test(text))
          throw new Error("Cursor sign-in is unavailable.");
        checkedRoute = true;
        failures = 0;
      } else if (!response.ok) {
        await response.body?.cancel();
        if (++failures >= 3) break;
      } else {
        const result: unknown = await response.json();
        if (
          typeof result !== "object" ||
          !result ||
          !("accessToken" in result) ||
          !("refreshToken" in result) ||
          typeof result.accessToken !== "string" ||
          typeof result.refreshToken !== "string" ||
          !result.accessToken
        )
          break;
        accessToken = result.accessToken;
        break;
      }
    } catch {
      input.signal?.throwIfAborted();
      if (++failures >= 3) break;
    }
    await delay(Math.min(1000 * 1.2 ** attempt, 10_000), input.signal);
  }
  if (!accessToken) throw new Error("Cursor sign-in failed or expired. Please try again.");
  const rpc = async (method: string, body: object) => {
    const response = await fetch(`${BACKEND}/aiserver.v1.DashboardService/${method}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
      },
      body: JSON.stringify(body),
      signal: input.signal,
      redirect: "manual",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("Cursor account request failed.");
    }
    return (await response.json()) as Record<string, unknown>;
  };
  const apiKeyExpiresAtMs = Date.now() + input.apiKeyTtlMs;
  const result = await rpc("CreateUserApiKey", {
    name: input.apiKeyName,
    expiresAt: String(Math.floor(apiKeyExpiresAtMs)),
  });
  if (typeof result.apiKey !== "string" || !result.apiKey)
    throw new Error("Cursor did not return an API key.");
  let email: string | undefined;
  try {
    const me = await rpc("GetMe", {});
    email = typeof me.email === "string" ? me.email : undefined;
  } catch {
    input.signal?.throwIfAborted();
  }
  return { apiKey: result.apiKey, email, apiKeyExpiresAtMs };
}
