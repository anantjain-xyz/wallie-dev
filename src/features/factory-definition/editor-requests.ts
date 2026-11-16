import { z } from "zod";

import { factoryEditorHistoryResponseSchema } from "@/lib/factory-definitions/editor-contracts";

export type FactoryEditorHistory = z.infer<typeof factoryEditorHistoryResponseSchema>;

export const draftSavedSchema = z.object({ draft: z.object({ id: z.string().uuid() }) });

const failureSchema = z.object({
  error: z.string(),
  diagnostics: z
    .array(z.object({ path: z.array(z.union([z.string(), z.number()])), message: z.string() }))
    .optional(),
});

export type EditorDiagnostic = NonNullable<z.infer<typeof failureSchema>["diagnostics"]>[number];

export class FactoryEditorRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly diagnostics: EditorDiagnostic[],
  ) {
    super(message);
  }
}

export async function fetchFactoryEditor<Schema extends z.ZodTypeAny>(
  url: string,
  schema: Schema,
  options?: RequestInit,
): Promise<z.output<Schema>> {
  const response = await fetch(url, { cache: "no-store", ...options });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = failureSchema.safeParse(body);
    throw new FactoryEditorRequestError(
      failure.success ? failure.data.error : "The factory definition request failed.",
      response.status,
      failure.success ? (failure.data.diagnostics ?? []) : [],
    );
  }
  return schema.parse(body);
}

export function factoryEditorPost(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}
