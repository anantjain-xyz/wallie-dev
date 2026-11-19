import { z } from "zod";

import { enforceRateLimit } from "@/lib/rate-limit";
import {
  answerSessionSpecification,
  findSpecificationSession,
  readSessionSpecification,
} from "@/lib/sessions/specification";
import { answerSpecificationSchema } from "@/lib/sessions/specification-contracts";
import { createSupabaseAdminClient } from "@/lib/supabase/admin";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

type Context = { params: Promise<{ sessionId: string }> };

const sessionIdSchema = z.string().uuid();
const headers = { "Cache-Control": "private, no-store" };

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers });
}

async function loadContext(context: Context) {
  const parsed = sessionIdSchema.safeParse((await context.params).sessionId);
  if (!parsed.success)
    return { ok: false, response: json({ error: "Session not found." }, 404) } as const;
  const reader = await createSupabaseServerClient();
  const user = await getSupabaseUserOrNull(reader);
  if (!user) return { ok: false, response: json({ error: "Unauthorized." }, 401) } as const;

  const session = await findSpecificationSession(reader, parsed.data);
  return session
    ? ({ ok: true, reader, user, session } as const)
    : ({ ok: false, response: json({ error: "Specification not found." }, 404) } as const);
}

export async function GET(_request: Request, context: Context) {
  try {
    const access = await loadContext(context);
    return access.ok
      ? json(await readSessionSpecification(access.reader, access.session))
      : access.response;
  } catch {
    return json({ error: "Could not load the specification." }, 500);
  }
}

export async function POST(request: Request, context: Context) {
  try {
    const access = await loadContext(context);
    if (!access.ok) return access.response;
    const { reader, session, user } = access;

    const parsed = answerSpecificationSchema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) {
      return json({ error: parsed.error.issues[0]?.message ?? "Invalid answer." }, 400);
    }

    const [gated, member] = await Promise.all([
      enforceRateLimit("phaseAction", `${session.workspace_id}:${user.id}`),
      reader
        .from("workspace_members")
        .select("id")
        .eq("workspace_id", session.workspace_id)
        .eq("user_id", user.id)
        .eq("kind", "human")
        .eq("is_active", true)
        .maybeSingle(),
    ]);
    if (gated.response) {
      gated.response.headers.set("Cache-Control", headers["Cache-Control"]);
      return gated.response;
    }
    if (member.error) throw member.error;
    if (!member.data) return json({ error: "Active workspace membership is required." }, 403);

    const receipt = await answerSessionSpecification({
      admin: createSupabaseAdminClient(),
      session,
      actorMemberId: member.data.id,
      answer: parsed.data,
    });
    return json(receipt);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
    if (code === "42501") return json({ error: "You do not have access to answer." }, 403);
    if (code === "P0002" || code === "PT404")
      return json({ error: "Clarification not found." }, 404);
    if (code === "P0005")
      return json({ error: "This request was already used for a different answer." }, 409);
    if (["P0003", "40001", "55000", "PT409", "PT412"].includes(code)) {
      return json({ error: "The specification changed. Refresh before answering." }, 409);
    }
    if (code === "22023" || code === "22001") return json({ error: "Invalid answer." }, 400);
    return json({ error: "Could not submit the answer. Please retry." }, 500);
  }
}
