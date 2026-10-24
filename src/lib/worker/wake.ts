import "server-only";

import { workerWakeEnvSchema } from "@/env/cloudflare";

/** A committed enqueue stays successful even when Cloudflare is unavailable. */
export async function wakeWorker(
  input: Record<string, string | undefined> = process.env,
): Promise<void> {
  const parsed = workerWakeEnvSchema.safeParse(input);
  if (
    !parsed.success ||
    !parsed.data.WALLIE_WORKER_WAKE_URL ||
    !parsed.data.WALLIE_WORKER_WAKE_SECRET
  )
    return;
  try {
    const response = await fetch(parsed.data.WALLIE_WORKER_WAKE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${parsed.data.WALLIE_WORKER_WAKE_SECRET}` },
      redirect: "manual",
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok)
      console.warn("[worker-wake] scheduled dispatch will retry", { status: response.status });
    await response.body?.cancel();
  } catch {
    console.warn("[worker-wake] scheduled dispatch will retry");
  }
}
