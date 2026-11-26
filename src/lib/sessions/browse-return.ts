import { workspaceInboxPath, workspaceSessionsPath } from "@/lib/routes";

export function parseSessionBrowseReturn(workspaceSlug: string, value: unknown) {
  if (typeof value !== "string" || value.length > 4096 || /[#\\\s\u0000-\u001f\u007f]/.test(value))
    return null;
  const path = value.split("?", 1)[0];
  if (path === workspaceInboxPath(workspaceSlug)) return { href: value, label: "Inbox" } as const;
  if (path === workspaceSessionsPath(workspaceSlug))
    return { href: value, label: "Sessions" } as const;
  return null;
}
