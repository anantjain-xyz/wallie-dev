import "server-only";

import type { z } from "zod";

import { factoryResponseHeaders } from "@/lib/factories/route-context";
import { readBoundedJsonBody } from "@/lib/http/bounded-json-body";

const maxAutomationRequestBytes = 16 * 1024;

export function automationResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: factoryResponseHeaders });
}

export function automationError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  switch (code) {
    case "42501":
      return automationResponse({ error: "Factory manager access is required." }, 403);
    case "P0002":
    case "PT404":
      return automationResponse({ error: "Automation not found." }, 404);
    case "23505":
    case "PT409":
      return automationResponse({ error: "Automation changed. Reload before retrying." }, 409);
    case "P0011":
      return automationResponse({ error: "This factory is archived." }, 409);
    case "22023":
    case "23514":
    case "PT422":
      return automationResponse(
        { error: "The automation definition or assignment is invalid." },
        422,
      );
    default:
      return automationResponse({ error: "Could not complete the automation request." }, 500);
  }
}

export async function readAutomationCommand<Command, Input>(
  request: Request,
  schema: z.ZodType<Command, z.ZodTypeDef, Input>,
) {
  const raw = await readBoundedJsonBody(request, maxAutomationRequestBytes);
  if (!raw.ok && raw.code === "request_too_large") {
    return {
      ok: false,
      response: automationResponse({ error: "The automation request is too large." }, 413),
    } as const;
  }
  if (!raw.ok && raw.code === "unsupported_media_type") {
    return {
      ok: false,
      response: automationResponse({ error: "Send the automation command as JSON." }, 415),
    } as const;
  }
  const command = schema.safeParse(raw.ok ? raw.body : null);
  if (!command.success) {
    return {
      ok: false,
      response: automationResponse(
        { error: "Check the automation command fields and try again." },
        400,
      ),
    } as const;
  }
  return { ok: true, command: command.data } as const;
}
