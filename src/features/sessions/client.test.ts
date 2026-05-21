import { afterEach, describe, expect, it, vi } from "vitest";

import { createSessionFromClient } from "./client";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";

function mockFetch(response: { body: Record<string, unknown>; ok: boolean; status?: number }) {
  const fetchMock = vi.fn(async () => ({
    json: async () => response.body,
    ok: response.ok,
    status: response.status ?? (response.ok ? 201 : 400),
  }));

  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("createSessionFromClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an empty prompt before calling the API", async () => {
    const fetchMock = mockFetch({ body: { number: 7 }, ok: true });

    await expect(
      createSessionFromClient({} as never, { promptMd: "   ", workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow("Prompt is required.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the normalized create-session payload and returns the session number", async () => {
    const fetchMock = mockFetch({ body: { number: 42 }, ok: true });

    const result = await createSessionFromClient({} as never, {
      githubRepositoryId: `  ${REPOSITORY_ID}  `,
      linearIssueUrl: "  https://linear.app/team/issue/TEAM-42/some-slug  ",
      promptMd: "  Add SSO  ",
      title: "  Override Title  ",
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toEqual({ number: 42 });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      body: JSON.stringify({
        githubRepositoryId: REPOSITORY_ID,
        linearIssueUrl: "https://linear.app/team/issue/TEAM-42/some-slug",
        promptMd: "Add SSO",
        title: "Override Title",
        workspaceId: WORKSPACE_ID,
      }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
  });

  it("surfaces API errors", async () => {
    mockFetch({
      body: { error: "Complete workspace setup before starting a session." },
      ok: false,
      status: 409,
    });

    await expect(
      createSessionFromClient({} as never, {
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Complete workspace setup before starting a session.");
  });

  it("rejects malformed success responses", async () => {
    mockFetch({ body: { success: true }, ok: true });

    await expect(
      createSessionFromClient({} as never, {
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Session response did not include a session number.");
  });
});
