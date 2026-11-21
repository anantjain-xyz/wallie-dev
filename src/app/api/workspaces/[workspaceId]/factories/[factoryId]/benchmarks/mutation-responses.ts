import type { z } from "zod";

import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";

export async function readBenchmarkCommand<T>(
  request: Request,
  schema: z.ZodType<T>,
  validationMessage: string,
  maxBodyBytes = 256 * 1024,
) {
  const raw = await readBoundedJsonBody(request, maxBodyBytes);
  if (!raw.ok && raw.code === "request_too_large") {
    return {
      ok: false as const,
      response: Response.json(
        { error: "The benchmark request is too large." },
        { status: 413, headers },
      ),
    };
  }
  if (!raw.ok && raw.code === "unsupported_media_type") {
    return {
      ok: false as const,
      response: Response.json(
        { error: "Send the benchmark request as JSON." },
        { status: 415, headers },
      ),
    };
  }
  const command = schema.safeParse(raw.ok ? raw.body : null);
  return command.success
    ? { ok: true as const, data: command.data }
    : {
        ok: false as const,
        response: Response.json({ error: validationMessage }, { status: 400, headers }),
      };
}

export function benchmarkMutationFailure(resource: "suite" | "task", error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const messages: Record<string, string> = {
    "42501": "Only a factory manager can save benchmark revisions.",
    P0002: `The benchmark ${resource} is unavailable in this factory.`,
    P0011: "This factory is archived.",
    PT409: `The benchmark ${resource} changed. Reload the latest revision before saving.`,
    PT422: "A selected benchmark task revision is unavailable in this factory.",
    "22023": `Review the benchmark ${resource} details and selection before saving.`,
  };
  const message = code && Object.hasOwn(messages, code) ? messages[code] : undefined;
  return Response.json(
    { error: message ?? `Could not save the benchmark ${resource} revision.` },
    { status: code === "PT422" ? 422 : factoryErrorStatus(code), headers },
  );
}
