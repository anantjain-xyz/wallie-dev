import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  factoryAuditCursorTokenSchema,
  factoryAuditEventIdSchema,
  factoryAuditFacetSchema,
  factoryAuditSourceSchema,
  type FactoryAuditSource,
} from "@/lib/factories/audit-contracts";
import type { Database, Tables } from "@/lib/supabase/database.types";

export type { FactoryAuditSource } from "@/lib/factories/audit-contracts";

type AuditFacet = z.infer<typeof factoryAuditFacetSchema>;
type AuditPageQuery = {
  limit?: number;
  cursor?: string;
  facet?: AuditFacet;
  source?: FactoryAuditSource;
};

export type FactoryAuditEvent = Pick<
  Tables<"factory_audit_events">,
  "action" | "actor_member_id" | "created_at" | "detail" | "factory_id" | "subject_member_id"
> & { id: string };

const resourceFilters = {
  grant: {
    actions: ["execution_grant.approved", "execution_grant.updated", "execution_grant.revoked"],
    key: "id",
  },
  principal: { actions: ["service_principal.created"], key: "id" },
  binding: {
    actions: ["credential_binding.created", "credential_binding.revoked"],
    key: "bindingId",
  },
  "mcp-binding": {
    actions: ["mcp_secret_binding.created", "mcp_secret_binding.revoked"],
    key: "bindingId",
  },
};
const governanceActions = [
  ...Object.values(resourceFilters).flatMap(({ actions }) => actions),
  "machine_token.issued",
  "machine_token.revoked",
];

const auditCursorSchema = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().uuid(),
    factoryId: z.string().uuid(),
    source: factoryAuditSourceSchema.nullable(),
    facet: factoryAuditFacetSchema.nullable(),
    createdAt: z.string().datetime({ offset: true }),
    id: factoryAuditEventIdSchema,
  })
  .strict();

export class FactoryAuditCursorError extends Error {
  constructor() {
    super("This audit cursor is invalid for the selected history.");
    this.name = "FactoryAuditCursorError";
  }
}

export async function readFactoryAuditPage(
  client: SupabaseClient<Database>,
  workspaceId: string,
  factoryId: string,
  query: AuditPageQuery = {},
): Promise<{ events: FactoryAuditEvent[]; nextCursor: string | null }> {
  const { limit = 50, cursor, source = null, facet = null } = query;
  const scope = { version: 1, workspaceId, factoryId, source, facet } satisfies Pick<
    z.infer<typeof auditCursorSchema>,
    "version" | "workspaceId" | "factoryId" | "source" | "facet"
  >;
  let request = client
    .from("factory_audit_events")
    .select(
      "event_id:id::text, factory_id, action, actor_member_id, subject_member_id, detail, created_at",
    )
    .eq("workspace_id", workspaceId)
    .eq("factory_id", factoryId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);

  if (source?.kind === "event") {
    request = request.filter("id", "eq", source.id);
  } else if (source?.kind === "actor") {
    request = request.eq("actor_member_id", source.id);
  } else if (source) {
    const { actions, key } = resourceFilters[source.kind];
    request = request.in("action", actions).eq(`detail->>${key}`, source.id);
  }
  if (facet && (!source || source.kind === "event" || source.kind === "actor")) {
    request = request.in("action", governanceActions);
  }

  if (cursor !== undefined) {
    const decoded = readAuditCursor(cursor);
    if (
      decoded.workspaceId !== scope.workspaceId ||
      decoded.factoryId !== scope.factoryId ||
      decoded.facet !== scope.facet ||
      decoded.source?.kind !== scope.source?.kind ||
      decoded.source?.id !== scope.source?.id
    ) {
      throw new FactoryAuditCursorError();
    }
    const { createdAt, id } = decoded;
    request = request.or(`created_at.lt.${createdAt},and(created_at.eq.${createdAt},id.lt.${id})`);
  }

  const { data, error } = await request;
  if (error) throw error;
  const events = data.slice(0, limit).map(({ event_id: id, ...event }) => ({ ...event, id }));
  const last = events.at(-1);
  const nextCursor =
    data.length > limit && last
      ? Buffer.from(JSON.stringify({ ...scope, createdAt: last.created_at, id: last.id })).toString(
          "base64url",
        )
      : null;
  return { events, nextCursor };
}

function readAuditCursor(cursor: string) {
  try {
    const token = factoryAuditCursorTokenSchema.parse(cursor);
    return auditCursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
  } catch {
    throw new FactoryAuditCursorError();
  }
}
