import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import {
  ALLOWED_AGENT_CONFIG_KEYS,
  RECOMMENDED_AGENT_CONFIG_DEFAULTS,
  type AgentConfigKey,
  getRecommendedAgentConfigDefault,
  isAgentConfigKey,
  normalizeAgentProviderName,
  parseAgentConfigValue,
} from "@/lib/agent-config/contracts";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const listQuerySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

const batchUpsertEnvelopeSchema = z
  .object({
    config: z.record(z.unknown()),
    workspaceId: z.string().uuid("Workspace id is invalid."),
  })
  .superRefine((value, context) => {
    const keys = Object.keys(value.config);
    if (keys.length === 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "At least one agent configuration field is required.",
        path: ["config"],
      });
    }

    for (const key of keys) {
      if (!isAgentConfigKey(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Field must be one of: ${ALLOWED_AGENT_CONFIG_KEYS.join(", ")}.`,
          path: ["config", key],
        });
      }
    }
  });

const defaultsEnvelopeSchema = z.object({
  skipKeys: z
    .array(
      z.enum(ALLOWED_AGENT_CONFIG_KEYS, {
        errorMap: () => ({
          message: `skipKeys must include only: ${ALLOWED_AGENT_CONFIG_KEYS.join(", ")}`,
        }),
      }),
    )
    .optional(),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type AgentConfigEntry = {
  key: AgentConfigKey;
  value: unknown;
};

export type ListAgentConfigResponse = {
  config: AgentConfigEntry[];
};

export type BatchUpsertAgentConfigRequest = {
  config: Partial<Record<AgentConfigKey, unknown>>;
  workspaceId: string;
};

export type AgentConfigFieldErrors = Partial<Record<AgentConfigKey, string>>;

export type BatchUpsertAgentConfigResponse = {
  entries: AgentConfigEntry[];
};

export type BatchUpsertAgentConfigErrorResponse = {
  error: string;
  fieldErrors?: AgentConfigFieldErrors;
};

export type ApplyAgentConfigDefaultsResponse = {
  applied: AgentConfigEntry[];
  skippedKeys: AgentConfigKey[];
};

export async function GET(request: NextRequest) {
  const parsed = listQuerySchema.safeParse({
    workspaceId: request.nextUrl.searchParams.get("workspaceId"),
  });

  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(parsed.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", access.context.workspace.id)
    .order("key", { ascending: true });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const response: ListAgentConfigResponse = {
    config: (data ?? [])
      .filter((row): row is typeof row & { key: AgentConfigKey } => isAgentConfigKey(row.key))
      .map((row) => ({
        key: row.key,
        value:
          row.key === "agent_provider" && typeof row.value_json === "string"
            ? (normalizeAgentProviderName(row.value_json) ?? row.value_json)
            : row.value_json,
      })),
  };

  return NextResponse.json(response, { status: 200 });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const envelope = batchUpsertEnvelopeSchema.safeParse(body);

  if (!envelope.success) {
    return NextResponse.json(
      { error: envelope.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const fieldErrors: AgentConfigFieldErrors = {};
  const entries: AgentConfigEntry[] = [];

  for (const [key, value] of Object.entries(envelope.data.config)) {
    if (!isAgentConfigKey(key)) continue;
    const valueResult = parseAgentConfigValue(key, value);
    if (!valueResult.ok) {
      fieldErrors[key] = valueResult.error;
      continue;
    }
    entries.push({ key, value: valueResult.value });
  }

  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json(
      {
        error: "Agent configuration contains invalid fields.",
        fieldErrors,
      } satisfies BatchUpsertAgentConfigErrorResponse,
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(envelope.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  // PostgREST sends this bulk upsert as one SQL statement. PostgreSQL executes
  // the entire statement in a transaction, so a constraint failure on any row
  // rolls back every submitted field.
  const { error } = await admin.from("workspace_agent_config").upsert(
    entries.map((entry) => ({
      key: entry.key,
      value_json: entry.value as Json,
      workspace_id: access.context.workspace.id,
    })),
    { onConflict: "workspace_id,key" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const response: BatchUpsertAgentConfigResponse = {
    entries,
  };

  return NextResponse.json(response, { status: 200 });
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const envelope = defaultsEnvelopeSchema.safeParse(body);

  if (!envelope.success) {
    return NextResponse.json(
      { error: envelope.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const access = await requireWorkspaceAccessById(envelope.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { data, error: loadError } = await admin
    .from("workspace_agent_config")
    .select("key, value_json")
    .eq("workspace_id", access.context.workspace.id);

  if (loadError) {
    return NextResponse.json({ error: loadError.message }, { status: 500 });
  }

  const existingKeys = new Set((data ?? []).map((row) => row.key));
  const skippedKeys = new Set<AgentConfigKey>(envelope.data.skipKeys ?? []);
  const existingProviderRow = (data ?? []).find((row) => row.key === "agent_provider");
  const configuredProvider =
    typeof existingProviderRow?.value_json === "string"
      ? normalizeAgentProviderName(existingProviderRow.value_json)
      : null;
  const defaultsProvider = configuredProvider ?? RECOMMENDED_AGENT_CONFIG_DEFAULTS.agent_provider;
  const missingDefaults = ALLOWED_AGENT_CONFIG_KEYS.filter(
    (key) => !existingKeys.has(key) && !skippedKeys.has(key),
  );

  if (missingDefaults.length === 0) {
    return NextResponse.json(
      { applied: [], skippedKeys: [...skippedKeys] } satisfies ApplyAgentConfigDefaultsResponse,
      { status: 200 },
    );
  }

  const rows = missingDefaults.map((key) => ({
    key,
    value_json: getRecommendedAgentConfigDefault(key, defaultsProvider) as Json,
    workspace_id: access.context.workspace.id,
  }));

  const { error: upsertError } = await admin.from("workspace_agent_config").upsert(rows, {
    onConflict: "workspace_id,key",
  });

  if (upsertError) {
    return NextResponse.json({ error: upsertError.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      applied: missingDefaults.map((key) => ({
        key,
        value: getRecommendedAgentConfigDefault(key, defaultsProvider),
      })),
      skippedKeys: [...skippedKeys],
    } satisfies ApplyAgentConfigDefaultsResponse,
    { status: 200 },
  );
}
