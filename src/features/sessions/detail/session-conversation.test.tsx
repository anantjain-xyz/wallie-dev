// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { SessionConversationMessage } from "@/lib/sessions/conversation-contracts";
import type { SessionReviewSession } from "./data";
import { SessionInspector } from "./session-inspector";

const now = "2026-11-18T21:00:00.000Z";
const session: SessionReviewSession = {
  archivedAt: null,
  artifacts: [],
  attachments: [],
  createdAt: now,
  currentArtifactVersion: null,
  currentStageId: "stage",
  currentStageSlug: "plan",
  id: "11111111-1111-4111-8111-111111111111",
  linearIssueId: null,
  linearIssueUrl: null,
  number: 1,
  phaseCompletions: [],
  phaseStatus: "in_progress",
  pipeline: { stages: [] },
  promptMd: "Original request text",
  pullRequests: [],
  title: "Prepare release",
  updatedAt: now,
};
const endpoint = `/api/sessions/${session.id}/conversation`;

const source = { id: "source", label: "Release discussion", url: "https://example.test/release" };
const unavailableSource = { id: "unavailable", label: "Imported thread", url: "http://localhost" };

function message(sequence: number, kind: SessionConversationMessage["kind"] = "user") {
  return {
    authorLabel: { user: "Ada", agent: "Release agent", system: "Wallie" }[kind],
    bodyHtml: `<p>Message ${sequence}</p>`,
    bodyTruncated: false,
    createdAt: now,
    kind,
    sequence,
  };
}

function page(
  messages: Array<ReturnType<typeof message>>,
  newerCursor: string,
  {
    olderCursor = null,
    hasMoreNewer = false,
  }: { olderCursor?: string | null; hasMoreNewer?: boolean } = {},
) {
  return Response.json({
    hasMoreNewer,
    messages,
    newerCursor,
    olderCursor,
    sources: [source, unavailableSource],
  });
}

function mount() {
  render(
    <SessionInspector
      creatorDisplayName="Ada"
      initialNow={now}
      repository={null}
      session={session}
    />,
  );
  return screen.getByRole("button", { name: "Conversation" });
}

function messageBodies() {
  return within(screen.getByRole("list", { name: "Conversation messages" }))
    .getAllByRole("listitem")
    .map((item) => item.querySelector("p")?.textContent);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("session conversation", () => {
  it("points to the original request when the conversation contains a prompt excerpt", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(page([{ ...message(1), bodyTruncated: true }], "cursor1")),
    );
    fireEvent.click(mount());
    expect(await screen.findByText("Read the full prompt under Original request.")).toBeVisible();
  });

  it("loads on disclosure, pages backward, and drains newer pages when reopened", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        page([message(3, "agent"), message(4, "system")], "cursor4", { olderCursor: "before3" }),
      )
      .mockResolvedValueOnce(page([message(1), message(2)], "cursor2"))
      .mockResolvedValueOnce(page([message(5), message(6)], "cursor6", { hasMoreNewer: true }))
      .mockResolvedValueOnce(page([message(7)], "cursor7"));
    vi.stubGlobal("fetch", fetcher);
    const toggle = mount();

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: "Original request" })).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    await screen.findByText("Message 4");
    expect(fetcher).toHaveBeenNthCalledWith(
      1,
      endpoint,
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(screen.getByText("Agent", { exact: true })).toBeVisible();
    expect(screen.getByText("System", { exact: true })).toBeVisible();
    expect(screen.getByRole("link", { name: /Release discussion/ })).toHaveAttribute(
      "href",
      source.url,
    );
    expect(screen.getByText("Imported thread").closest("a")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    await screen.findByText("Message 1");
    expect(fetcher).toHaveBeenNthCalledWith(2, `${endpoint}?before=before3`, expect.anything());
    expect(messageBodies()).toEqual(["Message 1", "Message 2", "Message 3", "Message 4"]);

    fireEvent.click(toggle);
    expect(screen.queryByText("Message 4")).toBeNull();
    fireEvent.click(toggle);
    await screen.findByText("Message 7");
    expect(fetcher).toHaveBeenNthCalledWith(3, `${endpoint}?after=cursor4`, expect.anything());
    expect(fetcher).toHaveBeenNthCalledWith(4, `${endpoint}?after=cursor6`, expect.anything());
    expect(messageBodies()).toEqual([
      "Message 1",
      "Message 2",
      "Message 3",
      "Message 4",
      "Message 5",
      "Message 6",
      "Message 7",
    ]);
  });

  it("clears cached messages and sources when reconnect finds revoked access", async () => {
    let completeOlder: (response: Response) => void = () => {};
    const pendingOlder = new Promise<Response>((resolve) => {
      completeOlder = resolve;
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(page([message(4)], "cursor4", { olderCursor: "before4" }))
      .mockReturnValueOnce(pendingOlder)
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetcher);
    fireEvent.click(mount());
    await screen.findByText("Message 4");

    fireEvent.click(screen.getByRole("button", { name: "Load older messages" }));
    fireEvent(window, new Event("online"));

    await screen.findByText("Conversation unavailable.");
    expect(fetcher).toHaveBeenNthCalledWith(3, `${endpoint}?after=cursor4`, expect.anything());
    await act(async () => completeOlder(page([message(3)], "cursor3")));
    await waitFor(() =>
      expect(screen.queryByRole("list", { name: "Conversation messages" })).toBeNull(),
    );
    expect(screen.queryByText("Message 3")).toBeNull();
    expect(screen.queryByText("Message 4")).toBeNull();
    expect(screen.queryByRole("list", { name: "Conversation sources" })).toBeNull();
  });
});
