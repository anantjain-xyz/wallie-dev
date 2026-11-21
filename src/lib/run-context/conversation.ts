import type { Tables } from "@/lib/supabase/database.types";

type ContextMessage = Pick<
  Tables<"session_conversation_messages">,
  "sequence" | "author_label" | "body_md" | "body_truncated"
>;

export function formatRunContextMessage(message: ContextMessage) {
  return {
    sequence: message.sequence,
    body: [
      "Message " + message.sequence + " from " + message.author_label,
      ...(message.body_truncated ? ["The stored conversation excerpt is truncated."] : []),
      "",
      message.body_md,
    ].join("\n"),
  };
}
