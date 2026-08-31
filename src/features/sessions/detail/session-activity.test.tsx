import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  SessionActivity,
  SessionActivityFallback,
} from "@/features/sessions/detail/session-activity";

const mocked = vi.hoisted(() => ({
  loadWallieSessionData: vi.fn(),
}));

vi.mock("@/features/wallie/server", () => ({
  loadWallieSessionData: mocked.loadWallieSessionData,
}));

vi.mock("@/features/wallie/session-wallie-panel", () => ({
  SessionWalliePanel: () => <div>Loaded activity</div>,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(async () => ({})),
}));

const props = {
  archivedAt: null,
  context: {
    repository: null,
    sessionGithubRepositoryId: null,
    sessionId: "session-18",
    workspaceId: "workspace-1",
  },
  initialNow: "2026-07-18T12:00:00.000Z",
  workspaceSlug: "acme-corp",
};

describe("SessionActivity", () => {
  it("renders an isolated failure state when Wallie summary loading fails", async () => {
    mocked.loadWallieSessionData.mockRejectedValueOnce(new Error("activity unavailable"));

    const result = await SessionActivity(props);
    const html = renderToStaticMarkup(result);

    expect(html).toContain("Run activity is temporarily unavailable");
    expect(html).toContain("Session review is still available");
  });

  it("provides a stable streamed loading state", () => {
    const html = renderToStaticMarkup(<SessionActivityFallback />);

    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Loading run activity"');
  });
});
