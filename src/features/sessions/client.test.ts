import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSessionFromClient,
  loadSessionRepositoryOptionsFromClient,
  SessionOptionsChangedError,
  SessionAttachmentsChangedError,
  SessionCreationRejectedError,
  updateSessionTitleFromClient,
} from "./client";

const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const REPOSITORY_ID = "44444444-4444-4444-8444-444444444444";
const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const STAGE_ID = "66666666-6666-4666-8666-666666666666";
const ATTACHMENT_ID = "77777777-7777-4777-8777-777777777777";
const ROUTING_RULE_ID = "88888888-8888-4888-8888-888888888888";

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
  it("includes the confirmed override alongside the normal creation token", async () => {
    const fetchMock = mockFetch({
      body: { canonicalUrl: "/w/acme/sessions/42", number: 42 },
      ok: true,
    });
    const routingOverride = {
      expectedActivationNumber: 2,
      ruleId: ROUTING_RULE_ID,
      target: "rule_fallback" as const,
      reason: "Use the reviewed fallback for this task.",
    };
    const factoryDefinitionDigest = "d".repeat(64);
    await createSessionFromClient({
      factoryDefinitionDigest,
      factoryId: "33333333-3333-4333-8333-333333333333",
      promptMd: "Build it",
      requestId: SESSION_ID,
      routingOverride,
      workspaceId: WORKSPACE_ID,
    });
    const [, request] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(request.body))).toMatchObject({
      factoryDefinitionDigest,
      factoryId: "33333333-3333-4333-8333-333333333333",
      requestId: SESSION_ID,
      routingOverride,
    });
  });

  it.each([400, 401, 403, 409, 429])(
    "identifies a definitive HTTP %s rejection",
    async (status) => {
      mockFetch({ body: { error: "Rejected" }, ok: false, status });
      await expect(
        createSessionFromClient({ promptMd: "Create once", workspaceId: WORKSPACE_ID }),
      ).rejects.toBeInstanceOf(SessionCreationRejectedError);
    },
  );

  it.each([
    { status: 408 },
    { status: 500 },
    { status: 502 },
    { status: 409, code: "session_request_conflict" },
  ])(
    "leaves uncertain outcomes retryable with the original request: %o",
    async ({ status, code }) => {
      mockFetch({ body: { error: "Unconfirmed", code }, ok: false, status });
      const error = await createSessionFromClient({
        promptMd: "Create once",
        workspaceId: WORKSPACE_ID,
      }).catch((error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SessionCreationRejectedError);
    },
  );
  it("keeps the caller's request identity across retries", async () => {
    const fetchMock = mockFetch({
      body: { number: 7, canonicalUrl: "/w/acme/sessions/7" },
      ok: true,
    });
    const input = { requestId: SESSION_ID, promptMd: "Create once", workspaceId: WORKSPACE_ID };
    await createSessionFromClient(input);
    await createSessionFromClient(input);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      expect(
        JSON.parse((call as unknown as [string, RequestInit])[1].body as string),
      ).toMatchObject({ requestId: SESSION_ID });
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an empty work source before calling the API", async () => {
    const fetchMock = mockFetch({ body: { number: 7 }, ok: true });

    await expect(
      createSessionFromClient({ promptMd: "   ", workspaceId: WORKSPACE_ID }),
    ).rejects.toThrow("Enter a Linear issue URL or a prompt.");

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a Linear issue URL without a prompt", async () => {
    const fetchMock = mockFetch({
      body: { canonicalUrl: "/w/acme/sessions/42", number: 42 },
      ok: true,
    });

    await createSessionFromClient({
      linearIssueUrl: "  https://linear.app/acme/issue/TEAM-42/title  ",
      promptMd: "  ",
      workspaceId: WORKSPACE_ID,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions",
      expect.objectContaining({
        body: JSON.stringify({
          githubRepositoryId: null,
          linearIssueUrl: "https://linear.app/acme/issue/TEAM-42/title",
          promptMd: "",
          title: null,
          workspaceId: WORKSPACE_ID,
        }),
      }),
    );
  });

  it("posts the normalized create-session payload and returns the session number", async () => {
    const fetchMock = mockFetch({
      body: { canonicalUrl: "/w/acme/sessions/42", number: 42 },
      ok: true,
    });

    const result = await createSessionFromClient({
      attachmentIds: [ATTACHMENT_ID],
      draftSpecification: true,
      factoryDefinitionDigest: "a".repeat(64),
      githubRepositoryId: `  ${REPOSITORY_ID}  `,
      linearIssueUrl: "  https://linear.app/team/issue/TEAM-42/some-slug  ",
      promptMd: "  Add SSO  ",
      selectedStageIds: [STAGE_ID],
      title: "  Override Title  ",
      workspaceId: WORKSPACE_ID,
    });

    expect(result).toEqual({ canonicalUrl: "/w/acme/sessions/42", number: 42 });
    expect(fetchMock).toHaveBeenCalledWith("/api/sessions", {
      body: JSON.stringify({
        attachmentIds: [ATTACHMENT_ID],
        draftSpecification: true,
        factoryDefinitionDigest: "a".repeat(64),
        githubRepositoryId: REPOSITORY_ID,
        linearIssueUrl: "https://linear.app/team/issue/TEAM-42/some-slug",
        promptMd: "Add SSO",
        selectedStageIds: [STAGE_ID],
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
      createSessionFromClient({
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Complete workspace setup before starting a session.");
  });

  it("preserves a recognizable session-options conflict", async () => {
    mockFetch({
      body: {
        code: "session_options_changed",
        error: "The workspace pipeline changed. Refresh the stage options and try again.",
      },
      ok: false,
      status: 409,
    });

    const request = createSessionFromClient({
      promptMd: "Add SSO",
      selectedStageIds: [STAGE_ID],
      workspaceId: WORKSPACE_ID,
    });

    await expect(request).rejects.toBeInstanceOf(SessionOptionsChangedError);
    await expect(request).rejects.toMatchObject({ code: "session_options_changed" });
  });

  it("preserves an attachment conflict so retained files can be renewed", async () => {
    mockFetch({
      body: { code: "session_attachments_changed", error: "Images expired" },
      ok: false,
      status: 409,
    });
    const request = createSessionFromClient({
      promptMd: "Add SSO",
      attachmentIds: [ATTACHMENT_ID],
      workspaceId: WORKSPACE_ID,
    });
    await expect(request).rejects.toBeInstanceOf(SessionAttachmentsChangedError);
    await expect(request).rejects.toMatchObject({ code: "session_attachments_changed" });
  });

  it("rejects malformed success responses", async () => {
    mockFetch({ body: { success: true }, ok: true });

    await expect(
      createSessionFromClient({
        promptMd: "Add SSO",
        workspaceId: WORKSPACE_ID,
      }),
    ).rejects.toThrow("Session response did not include a session number.");
  });
});

describe("loadSessionRepositoryOptionsFromClient", () => {
  const factoryId = "33333333-3333-4333-8333-333333333333";
  const input = { factoryId, workspaceId: WORKSPACE_ID };
  const scopedOptions = { factoryId, linearIssueLinking: false };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not use a successful options response from a different factory", async () => {
    const fetchMock = mockFetch({
      body: {
        factoryId: "44444444-4444-4444-8444-444444444444",
        linearIssueLinking: false,
        repositoryOptions: [],
        stageOptions: [],
      },
      ok: true,
    });
    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Session options response was invalid.",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${WORKSPACE_ID}/session-repositories?factoryId=${factoryId}`,
      { cache: "no-store", method: "GET" },
    );
  });

  it("loads repository options lazily for the selected factory", async () => {
    const fetchMock = mockFetch({
      body: {
        ...scopedOptions,
        canDraftSpecification: true,
        defaultGithubRepositoryId: REPOSITORY_ID,
        factoryDefinitionDigest: "a".repeat(64),
        pipelineId: "55555555-5555-4555-8555-555555555555",
        repositoryOptions: [{ fullName: "acme/app", id: REPOSITORY_ID }],
        stageOptions: [
          {
            description: "Plan the work",
            id: "66666666-6666-4666-8666-666666666666",
            name: "Plan",
            position: 1,
          },
        ],
      },
      ok: true,
    });

    await expect(loadSessionRepositoryOptionsFromClient(input)).resolves.toEqual({
      ...scopedOptions,
      canDraftSpecification: true,
      defaultGithubRepositoryId: REPOSITORY_ID,
      factoryDefinitionDigest: "a".repeat(64),
      pipelineId: "55555555-5555-4555-8555-555555555555",
      repositoryOptions: [{ fullName: "acme/app", id: REPOSITORY_ID }],
      stageOptions: [
        {
          description: "Plan the work",
          id: "66666666-6666-4666-8666-666666666666",
          name: "Plan",
          position: 1,
        },
      ],
    });

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/workspaces/${WORKSPACE_ID}/session-repositories?factoryId=${factoryId}`,
      { cache: "no-store", method: "GET" },
    );
  });

  it("rejects options that omit the factory’s Linear capability", async () => {
    mockFetch({ body: { factoryId, repositoryOptions: [], stageOptions: [] }, ok: true });

    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Session options response was invalid.",
    );
  });

  it("surfaces repository option API errors", async () => {
    mockFetch({
      body: { error: "Workspace not found." },
      ok: false,
      status: 404,
    });

    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Workspace not found.",
    );
  });

  it("accepts only qualified option shapes attached to a valid active definition", async () => {
    const routingOverrideOptions = {
      activationNumber: 3,
      targets: [
        {
          stageId: STAGE_ID,
          ruleId: ROUTING_RULE_ID,
          target: "primary",
          modelKey: "openai/gpt-5.5",
          harness: "codex",
          workerRuntime: "node",
        },
      ],
    };
    const options = {
      ...scopedOptions,
      factoryDefinitionDigest: "d".repeat(64),
      repositoryOptions: [],
      stageOptions: [],
      routingOverrideOptions,
    };
    mockFetch({ body: options, ok: true });
    await expect(loadSessionRepositoryOptionsFromClient(input)).resolves.toMatchObject({
      routingOverrideOptions,
    });
    mockFetch({
      body: {
        ...options,
        routingOverrideOptions: { ...routingOverrideOptions, activationNumber: 0 },
      },
      ok: true,
    });
    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Session routing options response was invalid.",
    );
  });

  it("rejects malformed repository option responses", async () => {
    mockFetch({ body: { ...scopedOptions, repositoryOptions: null, stageOptions: [] }, ok: true });

    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Session options response was invalid.",
    );
  });

  it("rejects an invalid active definition digest", async () => {
    mockFetch({
      body: {
        ...scopedOptions,
        factoryDefinitionDigest: "invalid",
        repositoryOptions: [],
        stageOptions: [],
      },
      ok: true,
    });

    await expect(loadSessionRepositoryOptionsFromClient(input)).rejects.toThrow(
      "Session options response was invalid.",
    );
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
