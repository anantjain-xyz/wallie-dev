// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import Link from "next/link";
import { afterEach, expect, it, vi } from "vitest";

import { AgentPromptForm } from "./agent-prompt-form";

const { push, pushToast } = vi.hoisted(() => ({ push: vi.fn(), pushToast: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));
vi.mock("@/components/ui/toast", () => ({ useToast: () => ({ pushToast }) }));

const scope = {
  workspaceId: "55200000-0000-4000-8000-000000000001",
  factoryId: "55200000-0000-4000-8000-000000000002",
  workspaceSlug: "release",
};
const agentId = "55200000-0000-4000-8000-000000000003";
const revisionId = "55200000-0000-4000-8000-000000000004";
const api = `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/agents`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  push.mockReset();
  pushToast.mockReset();
});

it("keeps a conflicted draft, shows the latest text, and retries only from the reviewed base", async () => {
  const fetch = vi
    .fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ error: "Temporarily unavailable" }, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        revisions: [
          {
            id: revisionId,
            agent_id: agentId,
            revision_number: 3,
            prompt_md: "Another editor’s text",
          },
        ],
      }),
    )
    .mockResolvedValueOnce(
      Response.json(
        {
          revision: { id: revisionId, agent_id: agentId, revision_number: 4 },
        },
        { status: 201 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(
    <AgentPromptForm
      {...scope}
      form={{ kind: "revise", agentId, revision: 2, prompt: "Starting prompt" }}
      listQuery={{ q: "release" }}
    />,
  );

  expect(screen.getByText("Create a revision from Revision 2.")).toBeVisible();
  const textarea = screen.getByRole("textbox", { name: "Implementation prompt" });
  const save = screen.getByRole("button", { name: "Save prompt revision" });
  fireEvent.change(textarea, { target: { value: "My draft\n  with formatting" } });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Your draft is unchanged");
  expect(save).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent("Temporarily unavailable"),
  );
  expect(textarea).toHaveValue("My draft\n  with formatting");
  fireEvent.click(screen.getByRole("button", { name: "Load latest revision" }));
  expect(await screen.findByText("Another editor’s text")).toBeVisible();
  expect(textarea).toHaveValue("My draft\n  with formatting");
  expect(save).toBeDisabled();

  fireEvent.click(screen.getByRole("button", { name: "Keep draft and use Revision 3" }));
  expect(textarea).toHaveValue("My draft\n  with formatting");
  expect(save).toBeEnabled();
  fireEvent.click(save);
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      `/w/release/agents/${agentId}?factory=${scope.factoryId}&q=release&revision=${revisionId}#prompt-revision`,
    ),
  );
  const revisions = `${api}/${agentId}/prompt-revisions`;
  expect(fetch.mock.calls.map(([url]) => url)).toEqual([
    revisions,
    `${revisions}?limit=1`,
    `${revisions}?limit=1`,
    revisions,
  ]);
  for (const [index, expectedRevisionNumber] of [
    [0, 2],
    [3, 3],
  ]) {
    expect(JSON.parse(String(fetch.mock.calls[index][1].body))).toEqual({
      expectedRevisionNumber,
      promptMd: "My draft\n  with formatting",
    });
  }
  expect(pushToast).toHaveBeenCalledWith({
    title: "Revision 4 saved. Not published.",
    tone: "success",
  });
});

it("warns about leaving with an unsaved draft without losing the text", () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(
    <>
      <Link href="/w/release/agents">Back to agents</Link>
      <AgentPromptForm
        {...scope}
        form={{ kind: "revise", agentId, revision: 2, prompt: "Starting prompt" }}
      />
    </>,
  );
  const textarea = screen.getByRole("textbox", { name: "Implementation prompt" });
  const unload = () => window.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  expect(unload()).toBe(true);
  fireEvent.change(textarea, { target: { value: "Keep my changes" } });
  expect(unload()).toBe(false);
  expect(fireEvent.click(screen.getByRole("link", { name: "Back to agents" }))).toBe(false);
  expect(confirm).toHaveBeenCalledOnce();
  expect(textarea).toHaveValue("Keep my changes");
  fireEvent.change(textarea, { target: { value: "Starting prompt" } });
  expect(unload()).toBe(true);
});

it("suggests an editable identifier and retries a generated collision without changing the user's prompt", async () => {
  const fetch = vi
    .fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockResolvedValueOnce(Response.json({}, { status: 409 }))
    .mockResolvedValueOnce(
      Response.json(
        {
          revision: { id: revisionId, agent_id: agentId, revision_number: 1 },
        },
        { status: 201 },
      ),
    );
  vi.stubGlobal("fetch", fetch);
  render(<AgentPromptForm {...scope} form={{ kind: "create" }} />);
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Rélease Review" } });
  const identifier = screen.getByLabelText("Identifier");
  expect(identifier).toHaveValue("release-review");
  fireEvent.change(identifier, { target: { value: "weekly-review" } });
  fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "Rélease Review v2" } });
  expect(identifier).toHaveValue("weekly-review");
  fireEvent.change(identifier, { target: { value: "" } });
  expect(identifier).toHaveValue("release-review-v2");
  fireEvent.change(screen.getByLabelText("Implementation prompt"), {
    target: { value: "Synthetic review instructions" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(fetch.mock.calls.map(([url, request]) => [url, JSON.parse(String(request.body))])).toEqual(
    [
      [
        api,
        {
          name: "Rélease Review v2",
          slug: "release-review-v2",
          promptMd: "Synthetic review instructions",
        },
      ],
      [
        api,
        {
          name: "Rélease Review v2",
          slug: expect.stringMatching(/^release-review-v2-[a-f0-9]{8}$/),
          promptMd: "Synthetic review instructions",
        },
      ],
    ],
  );
});
