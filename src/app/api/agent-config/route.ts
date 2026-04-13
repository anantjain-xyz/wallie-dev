import { NextRequest, NextResponse } from "next/server";

import { z } from "zod";

import type { Json } from "@/lib/supabase/database.types";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const ALLOWED_KEYS = [
  "concurrency_limit",
  "stall_timeout_ms",
  "max_retries",
  "agent_provider",
  "agent_model",
] as const;

const listQuerySchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
});

const upsertSchema = z.object({
  key: z.enum(ALLOWED_KEYS, {
    errorMap: () => ({ message: `key must be one of: ${ALLOWED_KEYS.join(", ")}` }),
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

  const parsed = upsertSchema.safeParse(body);

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
  const { error } = await admin.from("workspace_agent_config").upsert(
    {
      key: parsed.data.key,
      value_json: parsed.data.value as Json,
      workspace_id: access.context.workspace.id,
    },
    { onConflict: "workspace_id,key" },
  );

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const response: UpsertAgentConfigResponse = {
    entry: { key: parsed.data.key, value: parsed.data.value },
  };

  return NextResponse.json(response, { status: 200 });
}
