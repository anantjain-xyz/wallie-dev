import "server-only";

import { parseFactoryDefinitionJson } from "@/lib/factory-definitions/serialization";
import { factoryResponseHeaders } from "@/lib/factories/route-context";
import { factoryErrorStatus } from "@/lib/factories/scope";

export function workflowAuthoringResponse(body: unknown, status = 200) {
  return Response.json(body, { status, headers: factoryResponseHeaders });
}

export async function readWorkflowAuthoringCommand(request: Request) {
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  )
    return null;
  const maxBytes = 264_192;
  if (Number(request.headers.get("content-length")) > maxBytes) return null;
  const text = await request.text().catch(() => "");
  if (Buffer.byteLength(text) > maxBytes) return null;
  const result = parseFactoryDefinitionJson(text);
  return result.ok ? result.value : null;
}

export function workflowAuthoringError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
  const status =
    code === "PT422"
      ? 422
      : code === "PT404"
        ? 404
        : factoryErrorStatus(typeof code === "string" ? code : undefined);
  const message =
    status < 500 &&
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "Could not complete the workflow editor request.";
  return workflowAuthoringResponse({ error: message }, status);
}
