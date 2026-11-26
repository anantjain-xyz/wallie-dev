import { getWorkspaceNavItems, workspaceBasePath, workspaceSessionsPath } from "@/lib/routes";
import { workspaceListReturnPath } from "@/lib/workspace-return-path";

export function workspaceFailureDestination(
  workspaceSlug: string,
  pathname: string,
  returnTo: string | null,
) {
  const base = workspaceBasePath(workspaceSlug);
  const sessions = workspaceSessionsPath(workspaceSlug);
  const current = pathname.replace(/\/$/, "");
  const parent = current.startsWith(`${base}/`)
    ? `${base}/${current.slice(base.length + 1).split("/")[0]}`
    : base;

  if (parent === sessions && parent !== current) {
    const list = workspaceListReturnPath(returnTo, workspaceSlug);
    if (list) {
      return {
        href: list,
        label: list.split("?")[0] === sessions ? "Back to sessions" : "Back to inbox",
      };
    }
  }
  const navItem = getWorkspaceNavItems(workspaceSlug).find(({ href }) => href === parent);
  if (navItem && parent !== current && parent !== base) {
    return { href: navItem.href, label: `Back to ${navItem.label.toLowerCase()}` };
  }
  return current === sessions
    ? { href: base, label: "Back to pipeline" }
    : { href: sessions, label: "Back to sessions" };
}
