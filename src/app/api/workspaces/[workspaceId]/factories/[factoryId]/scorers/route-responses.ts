import type { z } from "zod";

import { factoryResponseHeaders as headers } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";

// A valid 20,000-character rubric can use up to 12 JSON bytes per escaped code point.
const maxBodyBytes = 256 * 1024;

export async function readScorerCommand<T>(
  request: Request,
  schema: z.ZodType<T>,
  validationMessage: string,
) {
  const raw = await readBoundedJsonBody(request, maxBodyBytes);
  if (!raw.ok && raw.code === "request_too_large") {
    return {
      ok: false as const,
      response: Response.json(
        { error: "The scorer request is too large." },
        { status: 413, headers },
      ),
    };
  }
  if (!raw.ok && raw.code === "unsupported_media_type") {
    return {
      ok: false as const,
      response: Response.json({ error: "Send the scorer as JSON." }, { status: 415, headers }),
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

export function scorerWriteFailure(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  const messages: Record<string, string> = {
    "42501": "Only a factory manager can publish scorer revisions.",
    P0002: "The scorer is unavailable in this factory.",
    P0011: "This factory is archived.",
    PT409: "The scorer changed. Reload the latest revision before publishing.",
    "23505": "A scorer with this identifier already exists in this factory.",
    "22023": "Enter a rubric with valid evidence and scoring rules.",
  };
  const message = code && Object.hasOwn(messages, code) ? messages[code] : undefined;
  return Response.json(
    {
      error: message ?? "Could not publish the scorer revision.",
      ...(code === "23505" ? { code: "identifier_in_use" } : {}),
      ...(code === "PT409" ? { code: "stale_revision" } : {}),
    },
    { status: factoryErrorStatus(code), headers },
  );
}
