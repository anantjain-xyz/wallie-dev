import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import { ALLOWED_AGENT_CONFIG_KEYS, parseAgentConfigValue } from "@/lib/agent-config/contracts";
import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const listQuerySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

const upsertEnvelopeSchema = z.object({
  key: z.enum(ALLOWED_AGENT_CONFIG_KEYS, {
    errorMap: () => ({ message: `key must be one of: ${ALLOWED_AGENT_CONFIG_KEYS.join(", ")}` }),
  }),
  value: z.unknown(),
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

export type AgentConfigEntry = {
  key: string;
  value: unknown;
};

export type ListAgentConfigResponse = {
  config: AgentConfigEntry[];
};

export type UpsertAgentConfigResponse = {
  entry: AgentConfigEntry;
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
    config: (data ?? []).map((row) => ({ key: row.key, value: row.value_json })),
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

  const envelope = upsertEnvelopeSchema.safeParse(body);

  if (!envelope.success) {
    return NextResponse.json(
      { error: envelope.error.issues[0]?.message ?? "Invalid request." },
      { status: 400 },
    );
  }

  const valueResult = parseAgentConfigValue(envelope.data.key, envelope.data.value);
  if (!valueResult.ok) {
    return NextResponse.json({ error: valueResult.error }, { status: 400 });
  }

  const access = await requireWorkspaceAccessById(envelope.data.workspaceId, {
    requireManager: true,
  });

  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }

  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("workspace_agent_config").upsert(
    {
      key: envelope.data.key,
      value_json: valueResult.value as Json,
      workspace_id: access.context.workspace.id,
    },
    { onConflict: "workspace_id,key" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const response: UpsertAgentConfigResponse = {
    entry: { key: envelope.data.key, value: valueResult.value },
  };

  return NextResponse.json(response, { status: 200 });
}
