import { NextResponse } from "next/server";
import { z } from "zod";

import {
  agentConfigValueSchemas,
  type AgentProvider,
  modelMatchesProvider,
} from "@/lib/agent-config/contracts";
import { getCodexAccessTokenForUser, CodexNotConnectedError } from "@/lib/codex/tokens";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { requireWorkspaceAccessById } from "@/lib/workspaces/access";

const requestSchema = z.object({
  workspaceId: z.string().uuid("Workspace id is invalid."),
  provider: agentConfigValueSchemas.agent_provider,
  model: z
    .string()
    .trim()
    .min(1, "Model is required.")
    .max(100, "Model must be 100 characters or fewer."),
});

/**
 * Verify supports three outcomes:
 *   - `{ ok: true }`              — provider accepted a 1-token call.
 *   - `{ ok: false, error }`      — provider rejected, secrets missing, etc.
 *   - `{ ok: "skipped", reason }` — reachability is not checkable here. Used
 *     for `claude-code`, which runs the `claude` CLI in a per-session sandbox
 *     at pipeline time.
 */
export type VerifyAgentConfigResponse =
  | { ok: true }
  | { ok: false; error: string }
  | { ok: "skipped"; reason: string };

function verifyError(error: string, status = 200) {
  return NextResponse.json({ ok: false, error } satisfies VerifyAgentConfigResponse, { status });
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return verifyError("Invalid JSON body.", 400);
  }

  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return verifyError(parsed.error.issues[0]?.message ?? "Invalid request.", 400);
  }

  const { workspaceId, provider, model } = parsed.data;

  if (!modelMatchesProvider(provider, model)) {
    return NextResponse.json(
      {
        ok: false,
        error: providerModelMismatchMessage(provider),
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }

  // claude-code runs the `claude` CLI in a sandbox. Short-circuit before the
  // access check so we don't pretend we verified anything we can't actually
  // verify here.
  if (provider === "claude-code") {
    return NextResponse.json(
      {
        ok: "skipped",
        reason:
          "Claude Code runs the `claude` CLI inside a per-session sandbox. The model name is checked against the schema, and the CLI is exercised when the pipeline actually runs.",
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }

  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return verifyError(access.error, access.status);
  }

  return verifyCodex(access.context.user.id, model);
}

function providerModelMismatchMessage(provider: AgentProvider) {
  switch (provider) {
    case "claude-code":
      return 'Model must start with "claude-" for this provider.';
    case "codex":
      return 'Model must start with "gpt-", "o1", "o3", or "o4" for the Codex provider.';
  }
}

async function verifyCodex(
  userId: string,
  model: string,
): Promise<NextResponse<VerifyAgentConfigResponse>> {
  const admin = createSupabaseAdminClient();
  let accessToken: string;
  try {
    accessToken = await getCodexAccessTokenForUser(admin, userId);
  } catch (cause) {
    if (cause instanceof CodexNotConnectedError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Connect your Codex account in Settings first, then try Verify again.",
        } satisfies VerifyAgentConfigResponse,
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: cause instanceof Error ? cause.message : "Codex token lookup failed.",
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }

  try {
    const response = await fetch("https://chatgpt.com/backend-api/codex/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        originator: "codex_cli_rs",
      },
      body: JSON.stringify({
        model,
        instructions: "Reply with the single word: ok.",
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
        max_output_tokens: 1,
        store: false,
        stream: false,
      }),
    });

    if (response.ok || response.status === 202) {
      return NextResponse.json({ ok: true } satisfies VerifyAgentConfigResponse, { status: 200 });
    }

    const errorMessage = await extractApiErrorMessage(response);
    return NextResponse.json(
      { ok: false, error: errorMessage } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  } catch (cause) {
    return NextResponse.json(
      {
        ok: false,
        error: cause instanceof Error ? cause.message : "Codex verify call failed.",
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }
}

async function extractApiErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: { message?: string } | string };
    if (payload && typeof payload.error === "object" && payload.error?.message) {
      return payload.error.message;
    }
    if (typeof payload.error === "string") {
      return payload.error;
    }
  } catch {
    // fall through to status-text path below
  }
  return `${response.status} ${response.statusText || "request failed"}`.trim();
}
