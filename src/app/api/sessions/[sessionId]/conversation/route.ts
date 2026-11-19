import { z } from "zod";

import { renderConversationMarkdown } from "@/components/shared/markdown-content.server";
import { ConversationCursorError, readSessionConversation } from "@/lib/sessions/conversation";
import type { SessionConversationPage } from "@/lib/sessions/conversation-contracts";
import { getSupabaseUserOrNull } from "@/lib/supabase/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";

const sessionIdSchema = z.string().uuid();
const headers = { "Cache-Control": "private, no-store" };

function json(body: SessionConversationPage | { error: string }, status = 200) {
  return Response.json(body, { status, headers });
}

export async function GET(request: Request, context: { params: Promise<{ sessionId: string }> }) {
  const parsed = sessionIdSchema.safeParse((await context.params).sessionId);
  if (!parsed.success) return json({ error: "Session not found." }, 404);

  const search = new URL(request.url).searchParams;
  const before = search.getAll("before");
  const after = search.getAll("after");
  if (before.length + after.length > 1) return json({ error: "Invalid conversation cursor." }, 400);
  const window = after.length
    ? { direction: "after" as const, cursor: after[0] }
    : before.length
      ? { direction: "before" as const, cursor: before[0] }
      : undefined;

  try {
    const reader = await createSupabaseServerClient();
    if (!(await getSupabaseUserOrNull(reader))) return json({ error: "Unauthorized." }, 401);

    const page = await readSessionConversation({ reader, sessionId: parsed.data, window });
    if (!page) return json({ error: "Session not found." }, 404);
    return json({
      ...page,
      messages: page.messages.map(({ bodyMarkdown, ...message }) => ({
        ...message,
        bodyHtml: renderConversationMarkdown(bodyMarkdown),
      })),
    });
  } catch (error) {
    if (error instanceof ConversationCursorError) return json({ error: error.message }, 400);
    return json({ error: "Could not load the conversation." }, 500);
  }
}
