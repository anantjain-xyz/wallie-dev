// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { CreateWorkflowDialog } from "./create-workflow-form";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

it("shows the saved workflow and a scoped editor link if navigation has not completed", async () => {
  const endpoint = "/api/workspaces/workspace/factories/factory/workflows";
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, options) =>
    Response.json({ workflow: JSON.parse(String(options?.body)) }, { status: 201 }),
  );
  vi.stubGlobal("fetch", fetch);
  const user = userEvent.setup();
  render(
    <OverlayProvider>
      <CreateWorkflowDialog
        endpoint={endpoint}
        factoryId="factory"
        factoryName="Release factory"
        workspaceSlug="release"
        prerequisites={{ state: "no-definition" }}
      />
    </OverlayProvider>,
  );
  const trigger = screen.getByRole("button", { name: "New workflow" });
  await user.click(trigger);
  await user.type(screen.getByRole("textbox", { name: "Workflow name" }), "Release review");
  await user.click(screen.getByRole("button", { name: "Create workflow" }));

  const confirmation = await screen.findByRole("dialog", { name: "Workflow created" });
  const [url, request] = fetch.mock.calls[0]!;
  const { workflowId } = JSON.parse(String(request?.body)) as { workflowId: string };
  const href = `/w/release/workflows/${workflowId}?factory=factory`;
  expect(url).toBe(endpoint);
  expect(push).toHaveBeenCalledExactlyOnceWith(href);
  expect(within(confirmation).getByRole("status")).toHaveTextContent(
    "This workflow isn’t published.",
  );
  expect(within(confirmation).getByRole("link", { name: "Open editor" })).toHaveAttribute(
    "href",
    href,
  );
  expect(within(confirmation).queryByRole("button", { name: /creat/i })).not.toBeInTheDocument();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("textbox", { name: "Workflow name" })).toHaveValue("");
});
