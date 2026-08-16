export const SESSION_SUBMIT_KEY_SHORTCUTS = "Meta+Enter Control+Enter";

export function isSessionSubmitShortcut(event: Pick<KeyboardEvent, "ctrlKey" | "key" | "metaKey">) {
  return (event.metaKey || event.ctrlKey) && event.key === "Enter";
}
