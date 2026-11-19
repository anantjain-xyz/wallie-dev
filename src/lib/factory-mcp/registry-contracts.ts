import { z } from "zod";

import {
  mcpAuthKindSchema,
  mcpEndpointSchema,
  mcpOperationNamesSchema,
  mcpServerSlugSchema,
} from "./manifest";

const uuid = z.string().uuid();
const versionSchema = z.number().int().positive().safe();
const pagination = {
  afterId: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
};

export const factoryMcpRegistryQuerySchema = z.discriminatedUnion("resource", [
  z.strictObject({ resource: z.literal("revisions"), serverId: uuid.optional(), ...pagination }),
  z.strictObject({ resource: z.literal("bindings"), toolRevisionId: uuid, ...pagination }),
  z.strictObject({ resource: z.literal("secrets") }),
]);

const serverMetadata = {
  endpoint: mcpEndpointSchema,
  operationNames: mcpOperationNamesSchema,
  authKind: mcpAuthKindSchema,
};

export const factoryMcpRegistryCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("register"),
    name: z.string().trim().min(1).max(120),
    slug: mcpServerSlugSchema,
    ...serverMetadata,
  }),
  z.strictObject({
    action: z.literal("revise"),
    serverId: uuid,
    expectedRevisionNumber: versionSchema,
    ...serverMetadata,
  }),
  z.strictObject({ action: z.literal("revoke"), serverId: uuid, revisionId: uuid }),
  z.strictObject({
    action: z.literal("bind-secret"),
    grantId: uuid,
    grantVersion: versionSchema,
    agentId: uuid,
    toolRevisionId: uuid,
    workspaceSecretId: uuid,
  }),
  z.strictObject({ action: z.literal("revoke-secret"), bindingId: uuid }),
]);
