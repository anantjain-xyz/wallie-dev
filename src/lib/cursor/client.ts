import type { CursorConnectionStatus } from "@/lib/cursor/contracts";

export type CursorModelOption = {
  label: string;
  value: string;
};

export async function discoverCursorModels(signal?: AbortSignal): Promise<{
  connectionStatus?: CursorConnectionStatus;
  models: CursorModelOption[];
}> {
  const response = await fetch("/api/cursor/models", { cache: "no-store", signal });
  const payload = (await response.json().catch(() => null)) as {
    error?: string;
    models?: CursorModelOption[];
  } | null;
  if (response.ok) return { models: payload?.models ?? [] };

  const statusResponse = await fetch("/api/cursor/connection", {
    cache: "no-store",
    signal,
  });
  const connectionStatus = (await statusResponse.json().catch(() => null)) as
    | (CursorConnectionStatus & { error?: string })
    | null;
  if (!statusResponse.ok || !connectionStatus) {
    throw new Error(
      connectionStatus?.error ?? payload?.error ?? "Cursor connection refresh failed.",
    );
  }
  return { connectionStatus, models: [] };
}
