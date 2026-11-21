import { defineSandboxProxy } from "@vercel/sandbox";

import {
  createBenchmarkInferenceRelayStore,
  relayBenchmarkInference,
} from "@/lib/factory-benchmarks/inference-relay";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  const proxy = defineSandboxProxy(
    (forwarded, identity) =>
      relayBenchmarkInference(forwarded, identity, {
        store: createBenchmarkInferenceRelayStore(createSupabaseAdminClient()),
        signal: request.signal,
      }),
    () => new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } }),
  );
  try {
    return await proxy(request);
  } catch {
    return new Response(null, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
