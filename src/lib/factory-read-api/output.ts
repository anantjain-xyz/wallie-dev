import "server-only";

import { isIP } from "node:net";

import { renderConversationMarkdown } from "@/components/shared/markdown-content.server";
import { redactRunSensitiveText } from "@/lib/agent-runner/redact-sensitive-text";
import { conversationSourceHref } from "@/lib/sessions/conversation-contracts";

const PRIVATE_PATH =
  /(?:^|\/)(?:storage\/v1|(?:session-)?attachments|private-media|(?:review|validation)-evidence|sandbox|\.wallie|internal)(?:\/|$)/i;
const PRIVATE_HOST =
  /(?:^|\.)(?:localhost|local|internal|supabase\.co|amazonaws\.com|storage\.googleapis\.com|blob\.core\.windows\.net)$/i;
const URL_TEXT =
  /\b(?:https?:\/\/|wallie-evidence:|sandbox:|file:|blob:|data:image\/)[^\s<>"'`()\[\]{}]+/giu;
const WALLIE_CREDENTIAL =
  /\bwallie_(?:mt|oa|or|oc)_[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/gi;

function redactCredentials(value: string) {
  return redactRunSensitiveText(value).replace(WALLIE_CREDENTIAL, "[redacted]");
}

export function safeFactoryReadSourceHref(value: string | null): string | null {
  if (!value) return null;
  const href = conversationSourceHref(value);
  if (!href) return null;
  const url = new URL(href);
  const host = url.hostname.replace(/\.$/, "").replace(/^\[|\]$/g, "");
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).replaceAll("\\", "/");
  } catch {
    return null;
  }
  if (
    !host.includes(".") ||
    isIP(host) ||
    PRIVATE_HOST.test(host) ||
    redactCredentials(host) !== host ||
    PRIVATE_PATH.test(path) ||
    /%[0-9a-f]{2}/i.test(path) ||
    redactCredentials(path) !== path
  ) {
    return null;
  }
  url.search = "";
  url.hash = "";
  return url.href;
}

export function safeFactoryReadText(value: string): string {
  return redactCredentials(
    value.replace(URL_TEXT, (href) => safeFactoryReadSourceHref(href) ?? "[link unavailable]"),
  );
}

export function renderFactoryReadMarkdown(value: string): string {
  return renderConversationMarkdown(value, {
    text: safeFactoryReadText,
    link: safeFactoryReadSourceHref,
  });
}
