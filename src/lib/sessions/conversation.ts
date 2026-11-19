import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  conversationSourceHref,
  type SessionConversationMessage,
  type SessionConversationPage,
} from "@/lib/sessions/conversation-contracts";
import type { Database } from "@/lib/supabase/database.types";

type Client = SupabaseClient<Database>;
type FactoryScope = { workspaceId: string; factoryId: string };
type ConversationActor = FactoryScope & { memberId: string };
type ConversationWindow = { direction: "before" | "after"; cursor: string };
type MarkdownPage = Omit<SessionConversationPage, "messages"> & {
  messages: (Omit<SessionConversationMessage, "bodyHtml"> & { bodyMarkdown: string })[];
};

const messagePageSize = 20;
const maxSourceLinks = 50;
const cursorTokenSchema = z
  .string()
  .min(1)
  .max(320)
  .regex(/^[A-Za-z0-9_-]+$/);
const cursorSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    factoryId: z.string().uuid(),
    sequence: z.number().int().nonnegative().max(2_147_483_647),
  })
  .strict();
type ConversationCursor = z.infer<typeof cursorSchema>;

export class ConversationCursorError extends Error {
  constructor() {
    super("Invalid conversation cursor.");
    this.name = "ConversationCursorError";
  }
}

function readCursor(raw: string, scope: FactoryScope & { sessionId: string }) {
  try {
    const token = cursorTokenSchema.parse(raw);
    const cursor = cursorSchema.parse(JSON.parse(Buffer.from(token, "base64url").toString("utf8")));
    if (
      cursor.sessionId === scope.sessionId &&
      cursor.workspaceId === scope.workspaceId &&
      cursor.factoryId === scope.factoryId
    ) {
      return cursor;
    }
  } catch {
    // Normalize decoding and schema errors to the same response.
  }
  throw new ConversationCursorError();
}

function writeCursor(scope: Omit<ConversationCursor, "sequence">, sequence: number) {
  return Buffer.from(JSON.stringify({ ...scope, sequence })).toString("base64url");
}

export async function readSessionConversation(input: {
  reader: Pick<Client, "from">;
  sessionId: string;
  window?: ConversationWindow;
}): Promise<MarkdownPage | null> {
  const lookup = () =>
    input.reader
      .from("sessions")
      .select("id, workspace_id, factory_id")
      .eq("id", input.sessionId)
      .maybeSingle();
  const { data: session, error: sessionError } = await lookup();
  if (sessionError) throw sessionError;
  if (!session) return null;

  const scope = {
    version: 1,
    sessionId: session.id,
    workspaceId: session.workspace_id,
    factoryId: session.factory_id,
  } as const;
  const cursor = input.window ? readCursor(input.window.cursor, scope) : null;
  const forward = input.window?.direction === "after";
  let messagesQuery = input.reader
    .from("session_conversation_messages")
    .select("sequence, created_at, author_kind, author_label, body_md, body_truncated")
    .eq("workspace_id", scope.workspaceId)
    .eq("factory_id", scope.factoryId)
    .eq("session_id", scope.sessionId)
    .order("sequence", { ascending: forward })
    .limit(messagePageSize + 1);
  if (cursor) {
    messagesQuery = forward
      ? messagesQuery.gt("sequence", cursor.sequence)
      : messagesQuery.lt("sequence", cursor.sequence);
  }

  const [messages, sources] = await Promise.all([
    messagesQuery,
    input.reader
      .from("session_conversation_sources")
      .select("id, provider, label, source_url")
      .eq("workspace_id", scope.workspaceId)
      .eq("factory_id", scope.factoryId)
      .eq("session_id", scope.sessionId)
      .order("created_at")
      .order("id")
      .limit(maxSourceLinks),
  ]);
  if (messages.error) throw messages.error;
  if (sources.error) throw sources.error;

  // Recheck RLS before returning bodies if access changed during either read.
  const current = await lookup();
  if (current.error) throw current.error;
  if (!current.data) return null;

  const rows = messages.data ?? [];
  const hasMore = rows.length > messagePageSize;
  const page = rows.slice(0, messagePageSize);
  if (!forward) page.reverse();

  return {
    messages: page.map((row) => ({
      sequence: row.sequence,
      createdAt: row.created_at,
      kind: row.author_kind,
      authorLabel: row.author_label,
      bodyMarkdown: row.body_md,
      bodyTruncated: row.body_truncated,
    })),
    sources: (sources.data ?? []).map((row) => ({
      id: row.id,
      label: row.label ?? row.provider,
      url: conversationSourceHref(row.source_url),
    })),
    olderCursor: !forward && hasMore ? writeCursor(scope, page[0].sequence) : null,
    newerCursor: writeCursor(scope, page.at(-1)?.sequence ?? cursor?.sequence ?? 0),
    hasMoreNewer: forward && hasMore,
  };
}

type SourceAddress = { provider: string; namespace: string; threadId: string };

function sourceParams(address: SourceAddress) {
  return {
    p_provider: address.provider,
    p_source_namespace: address.namespace,
    p_external_thread_id: address.threadId,
  };
}

export async function bindSessionConversationSource(input: {
  admin: Pick<Client, "rpc">;
  actor: ConversationActor;
  sessionId: string;
  source: SourceAddress & { label?: string; url?: string };
}) {
  const { actor, source } = input;
  const { data, error } = await input.admin
    .rpc("bind_session_conversation_source_once", {
      p_workspace_id: actor.workspaceId,
      p_factory_id: actor.factoryId,
      p_actor_member_id: actor.memberId,
      p_session_id: input.sessionId,
      ...sourceParams(source),
      p_label: source.label,
      p_source_url: source.url,
    })
    .single();
  if (error) throw error;
  return data;
}

export async function resolveSessionConversationSource(input: {
  reader: Pick<Client, "rpc">;
  workspaceId: string;
  source: SourceAddress;
}) {
  const { data, error } = await input.reader
    .rpc("resolve_session_conversation_source", {
      p_workspace_id: input.workspaceId,
      ...sourceParams(input.source),
    })
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function appendSessionConversationMessage(input: {
  admin: Pick<Client, "rpc">;
  actor: ConversationActor;
  sessionId: string;
  requestId: string;
  bodyMarkdown: string;
  origin?: { sourceId: string; messageId: string; actorId: string };
}) {
  const { actor, origin } = input;
  const { data, error } = await input.admin
    .rpc("append_session_conversation_message_once", {
      p_workspace_id: actor.workspaceId,
      p_factory_id: actor.factoryId,
      p_session_id: input.sessionId,
      p_actor_member_id: actor.memberId,
      p_request_id: input.requestId,
      p_body_md: input.bodyMarkdown,
      p_source_id: origin?.sourceId,
      p_external_message_id: origin?.messageId,
      p_external_actor_id: origin?.actorId,
    })
    .single();
  if (error) throw error;
  return data;
}
