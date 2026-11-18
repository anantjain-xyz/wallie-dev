import { z } from "zod";

export const MAX_MCP_OPERATIONS = 32;
export const MAX_MCP_BINDINGS = MAX_MCP_OPERATIONS;

export const mcpIdSchema = z
  .string()
  .uuid()
  .transform((id) => id.toLowerCase());

export const mcpServerSlugSchema = z
  .string()
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);

export const mcpEndpointSchema = z
  .string()
  .max(2048)
  .url()
  .regex(
    /^https:\/\/(?:\[[0-9a-fA-F:.]+\]|[a-zA-Z0-9.-]+)(?::(?=0*[1-9])[0-9]{1,5})?(?:\/[^?#\\\s]*)?$/,
    "Use a fixed HTTPS endpoint without user information, a query, or a fragment.",
  )
  .refine((endpoint) => !/[\s\p{Cc}]/u.test(endpoint), "Remove endpoint whitespace and controls.");

export const mcpOperationNamesSchema = z
  .array(z.string().regex(/^[A-Za-z0-9_.-]{1,80}$/))
  .min(1)
  .max(MAX_MCP_OPERATIONS)
  .refine((names) => new Set(names).size === names.length, "List each operation once.");

export const mcpAuthKindSchema = z.enum(["none", "bearer"]);

export const mcpBindingSourceSchema = z
  .object({
    toolRevisionId: mcpIdSchema,
    operations: mcpOperationNamesSchema,
    secretBindingId: mcpIdSchema.optional(),
  })
  .strict();

export const mcpManifestServerSchema = z
  .object({
    toolRevisionId: mcpIdSchema,
    serverId: mcpIdSchema,
    serverSlug: mcpServerSlugSchema,
    revisionNumber: z.number().int().positive().safe(),
    endpoint: mcpEndpointSchema,
    operations: mcpOperationNamesSchema,
    auth: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("none") }).strict(),
      z.object({ kind: z.literal("bearer"), secretBindingId: mcpIdSchema }).strict(),
    ]),
  })
  .strict();

export const factoryMcpManifestSchema = z
  .object({
    agentId: mcpIdSchema,
    servers: z.array(mcpManifestServerSchema).min(1).max(MAX_MCP_BINDINGS),
  })
  .strict()
  .superRefine(({ servers }, context) => {
    if (
      new Set(servers.map(({ serverId }) => serverId)).size !== servers.length ||
      new Set(servers.map(({ serverSlug }) => serverSlug)).size !== servers.length
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servers"],
        message: "Choose only one revision per MCP server.",
      });
    }
    if (mcpManifestScopeIds(servers).length > MAX_MCP_OPERATIONS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["servers"],
        message: `Choose at most ${MAX_MCP_OPERATIONS} MCP operations per agent.`,
      });
    }
  });

export type FactoryMcpManifest = z.infer<typeof factoryMcpManifestSchema>;
export type FactoryMcpBindingSource = z.infer<typeof mcpBindingSourceSchema>;
export type RuntimeMcpManifest = FactoryMcpManifest | { servers: [] };

export function mcpOperationScopeId(toolRevisionId: string, operation: string): string {
  return `${toolRevisionId}/${operation}`;
}

export function mcpManifestScopeIds(
  servers: readonly Pick<FactoryMcpManifest["servers"][number], "toolRevisionId" | "operations">[],
): string[] {
  return servers
    .flatMap(({ toolRevisionId, operations }) =>
      operations.map((operation) => mcpOperationScopeId(toolRevisionId, operation)),
    )
    .sort();
}

export function runtimeMcpManifest(manifest: FactoryMcpManifest | undefined): RuntimeMcpManifest {
  return manifest ?? { servers: [] };
}

export function mcpBindingsFromManifest(manifest: FactoryMcpManifest): FactoryMcpBindingSource[] {
  return manifest.servers.map(({ toolRevisionId, operations, auth }) => ({
    toolRevisionId,
    operations,
    ...(auth.kind === "bearer" ? { secretBindingId: auth.secretBindingId } : {}),
  }));
}
