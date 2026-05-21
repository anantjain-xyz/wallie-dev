import { NextResponse } from "next/server";
import { z } from "zod";

import {
  agentConfigValueSchemas,
  type AgentProvider,
  modelMatchesProvider,
} from "@/lib/agent-config/contracts";
import {
  ClaudeCodeNotConnectedError,
  getClaudeCodeCredentialForUser,
} from "@/lib/claude-code/tokens";
import type { CodexCredential } from "@/lib/codex/contracts";
import { getCodexCredentialForUser, CodexNotConnectedError } from "@/lib/codex/tokens";
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

const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

/**
 * Verify supports three outcomes:
 *   - `{ ok: true }`              — provider accepted a minimal reachability call.
 *   - `{ ok: false, error }`      — provider rejected, secrets missing, etc.
 *   - `{ ok: "skipped", reason }` — reachability is not checkable here. Used
 *     for CLI-backed credentials that are exercised in a per-session sandbox.
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

  const access = await requireWorkspaceAccessById(workspaceId, { requireManager: true });
  if (!access.ok) {
    return verifyError(access.error, access.status);
  }

  if (provider === "claude-code") {
    return verifyClaudeCode(access.context.user.id);
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

async function verifyClaudeCode(userId: string): Promise<NextResponse<VerifyAgentConfigResponse>> {
  const admin = createSupabaseAdminClient();
  try {
    await getClaudeCodeCredentialForUser(admin, userId);
  } catch (cause) {
    if (cause instanceof ClaudeCodeNotConnectedError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Connect an Anthropic API key in Settings first, then try Verify again.",
        } satisfies VerifyAgentConfigResponse,
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        error: cause instanceof Error ? cause.message : "Claude Code credential lookup failed.",
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }

  return NextResponse.json(
    {
      ok: "skipped",
      reason:
        "Anthropic API key is saved. Claude Code CLI reachability is checked inside the per-session sandbox when a pipeline run starts.",
    } satisfies VerifyAgentConfigResponse,
    { status: 200 },
  );
}

async function verifyCodex(
  userId: string,
  model: string,
): Promise<NextResponse<VerifyAgentConfigResponse>> {
  const admin = createSupabaseAdminClient();
  let credential: CodexCredential;
  try {
    credential = await getCodexCredentialForUser(admin, userId);
  } catch (cause) {
    if (cause instanceof CodexNotConnectedError) {
      return NextResponse.json(
        {
          ok: false,
          error: "Connect a Codex credential in Settings first, then try Verify again.",
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

  if (credential.type === "codex_access_token" || credential.type === "chatgpt_auth_json") {
    return NextResponse.json(
      {
        ok: "skipped",
        reason:
          "Codex subscription/access-token credentials are verified by the Codex CLI inside the per-session sandbox when a pipeline run starts.",
      } satisfies VerifyAgentConfigResponse,
      { status: 200 },
    );
  }

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.secret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: "Reply with the single word: ok.",
        max_output_tokens: OPENAI_RESPONSES_MIN_OUTPUT_TOKENS,
        store: false,
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
