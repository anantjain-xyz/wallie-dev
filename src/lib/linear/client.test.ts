import { afterEach, describe, expect, it, vi } from "vitest";

import { attachLinearPullRequest } from "./client";

function jsonResponse(payload: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

describe("attachLinearPullRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves the issue identifier and creates an idempotent URL attachment", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              description: null,
              id: "issue-uuid",
              identifier: "TEAM-42",
              state: { name: "In Progress" },
              title: "Ship feature",
              url: "https://linear.app/team/issue/TEAM-42",
            },
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          data: { attachmentCreate: { attachment: { id: "attachment-1" }, success: true } },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await attachLinearPullRequest("linear-key", "TEAM-42", {
      pullRequestNumber: 17,
      title: "Build: Ship feature",
      url: "https://github.com/acme/app/pull/17",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const attachmentRequest = fetchMock.mock.calls[1]![1] as RequestInit;
    expect(attachmentRequest.headers).toEqual({
      Authorization: "linear-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(attachmentRequest.body))).toMatchObject({
      variables: {
        input: {
          issueId: "issue-uuid",
          subtitle: "Pull request #17",
          title: "Build: Ship feature",
          url: "https://github.com/acme/app/pull/17",
        },
      },
    });
  });

  it("surfaces attachment mutation failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            issue: {
              description: null,
              id: "issue-uuid",
              identifier: "TEAM-42",
              state: { name: "In Progress" },
              title: "Ship feature",
              url: "https://linear.app/team/issue/TEAM-42",
            },
          },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Attachment denied" }] }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      attachLinearPullRequest("linear-key", "TEAM-42", {
        pullRequestNumber: 17,
        title: "Build: Ship feature",
        url: "https://github.com/acme/app/pull/17",
      }),
    ).rejects.toThrow("Linear API error: Attachment denied");
  });
});
