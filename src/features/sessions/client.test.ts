import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSessionFromClient,
  loadSessionRepositoryOptionsFromClient,
  updateSessionTitleFromClient,
} from "./client";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";

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
    const fetchMock = mockFetch({
      body: { canonicalUrl: "/w/acme/sessions/42", number: 42 },
      ok: true,
    });

    const result = await createSessionFromClient({} as never, {
      githubRepositoryId: `  ${REPOSITORY_ID}  `,
      linearIssueUrl: "  https://linear.app/team/issue/TEAM-42/some-slug  ",
      promptMd: "  Add SSO  ",
      title: "  Override Title  ",
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toEqual({ canonicalUrl: "/w/acme/sessions/42", number: 42 });
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

describe("loadSessionRepositoryOptionsFromClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("loads repository options lazily for the workspace", async () => {
    const fetchMock = mockFetch({
      body: {
        defaultGithubRepositoryId: REPOSITORY_ID,
        repositoryOptions: [{ fullName: "acme/app", id: REPOSITORY_ID }],
      },
      ok: true,
    });

    await expect(
      loadSessionRepositoryOptionsFromClient({ workspaceId: WORKSPACE_ID }),
    ).resolves.toEqual({
      defaultGithubRepositoryId: REPOSITORY_ID,
      repositoryOptions: [{ fullName: "acme/app", id: REPOSITORY_ID }],
    });

    expect(fetchMock).toHaveBeenCalledWith(`/api/workspaces/${WORKSPACE_ID}/session-repositories`, {
      method: "GET",
    });
  });

  it("surfaces repository option API errors", async () => {
    mockFetch({
      body: { error: "Workspace not found." },
      ok: false,
      status: 404,
    });

    await expect(
      loadSessionRepositoryOptionsFromClient({ workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow("Workspace not found.");
  });

  it("rejects malformed repository option responses", async () => {
    mockFetch({ body: { repositoryOptions: null }, ok: true });

    await expect(
      loadSessionRepositoryOptionsFromClient({ workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow("Repository response was invalid.");
  });
});

describe("updateSessionTitleFromClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an empty title before calling the API", async () => {
    const fetchMock = mockFetch({
      body: { id: SESSION_ID, title: "Updated title", updatedAt: "2026-06-07T12:00:00.000Z" },
      ok: true,
    });

    await expect(
      updateSessionTitleFromClient({
        sessionId: SESSION_ID,
        title: "   ",
      }),
    ).rejects.toThrow("Title is required.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("patches the normalized title and returns the updated title", async () => {
    const fetchMock = mockFetch({
      body: {
        id: SESSION_ID,
        title: "Updated title",
        updatedAt: "2026-06-07T12:00:00.000Z",
      },
      ok: true,
    });

    const result = await updateSessionTitleFromClient({
      sessionId: SESSION_ID,
      title: "  Updated title  ",
    });

    expect(result).toEqual({
      id: SESSION_ID,
      title: "Updated title",
      updatedAt: "2026-06-07T12:00:00.000Z",
    });
    expect(fetchMock).toHaveBeenCalledWith(`/api/sessions/${SESSION_ID}`, {
      body: JSON.stringify({ title: "Updated title" }),
      headers: { "content-type": "application/json" },
      method: "PATCH",
    });
  });

  it("surfaces update API errors", async () => {
    mockFetch({
      body: { error: "Session not found" },
      ok: false,
      status: 404,
    });

    await expect(
      updateSessionTitleFromClient({
        sessionId: SESSION_ID,
        title: "Updated title",
      }),
    ).rejects.toThrow("Session not found");
  });

  it("rejects malformed update success responses", async () => {
    mockFetch({ body: { success: true }, ok: true });

    await expect(
      updateSessionTitleFromClient({
        sessionId: SESSION_ID,
        title: "Updated title",
      }),
    ).rejects.toThrow("Session title response was invalid.");
  });
});
