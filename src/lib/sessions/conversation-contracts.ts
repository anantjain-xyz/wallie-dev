import type { SanitizedMarkdownHtml } from "@/components/shared/markdown-content";
import type { Enums } from "@/lib/supabase/database.types";

export type SessionConversationMessage = {
  sequence: number;
  createdAt: string;
  kind: Enums<"session_conversation_author_kind">;
  authorLabel: string;
  bodyHtml: SanitizedMarkdownHtml;
  bodyTruncated: boolean;
};

export type SessionConversationSource = {
  id: string;
  label: string;
  url: string | null;
};

export type SessionConversationPage = {
  messages: SessionConversationMessage[];
  sources: SessionConversationSource[];
  olderCursor: string | null;
  newerCursor: string;
  hasMoreNewer: boolean;
};

export function conversationSourceHref(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
