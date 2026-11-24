import type { z } from "zod/v4";

import { readResponseJson } from "@/features/settings/use-api-action";

export async function readConnectorResponse<S extends z.ZodType>(
  response: Response,
  schema: S,
): Promise<z.output<S>> {
  const parsed = schema.safeParse(await readResponseJson<unknown>(response));
  if (!parsed.success)
    throw new Error("The connector returned an invalid response. Refresh to try again.");
  return parsed.data;
}

export function connectorCommand(body: unknown, method: "POST" | "PUT" = "POST"): RequestInit {
  return {
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
    method,
  };
}
