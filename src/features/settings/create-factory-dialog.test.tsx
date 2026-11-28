// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { CreateFactoryDialog } from "@/features/settings/create-factory-dialog";
import { FACTORY_SLUG_TAKEN } from "@/lib/factories/contracts";

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const workspaceId = "00000000-0000-4000-8000-000000000001";
const factoryId = "00000000-0000-4000-8000-000000000002";

function setup() {
  const user = userEvent.setup();
  render(
    <OverlayProvider>
      <CreateFactoryDialog
        workspaceId={workspaceId}
        workspaceName="Northwind"
        workspaceSlug="northwind"
      />
    </OverlayProvider>,
  );
  return { user, trigger: screen.getByRole("button", { name: "New factory" }) };
}

afterEach(() => {
  cleanup();
  push.mockClear();
  refresh.mockClear();
  vi.unstubAllGlobals();
});

describe("New factory dialog", () => {
  it("suggests a canonical slug, respects edits, and returns focus on cancel", async () => {
    const { user, trigger } = setup();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "New factory" });
    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    const slugInput = within(dialog).getByRole("textbox", { name: "Factory slug" });
    expect(dialog).toHaveAccessibleDescription(/Northwind/);
    expect(name).toHaveFocus();
    await user.type(name, "Billing + Payments");
    expect(slugInput).toHaveValue("billing-payments");
    await user.clear(slugInput);
    await user.type(slugInput, "billing-team");
    await user.type(name, " Internal");
    expect(slugInput).toHaveValue("billing-team");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "Display name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Factory slug" })).toHaveValue("");
  });

  it("validates the edited slug instead of silently replacing it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.type(await screen.findByRole("textbox", { name: "Display name" }), "Payments");
    const slugInput = screen.getByRole("textbox", { name: "Factory slug" });
    await user.clear(slugInput);
    await user.type(slugInput, "Payments--Team");
    await user.click(screen.getByRole("button", { name: "Create factory" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "Use lowercase letters",
    );
    expect(slugInput).toHaveValue("Payments--Team");
    expect(slugInput).toHaveAttribute("aria-invalid", "true");
    expect(slugInput).toHaveFocus();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps both fields after a collision and opens the exact factory returned by the API", async () => {
    let finish!: (value: Response) => void;
    const fetch = vi
      .fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => (finish = resolve)))
      .mockResolvedValueOnce(Response.json({ factory: { id: factoryId } }, { status: 201 }));
    vi.stubGlobal("fetch", fetch);
    const { user, trigger } = setup();
    await user.click(trigger);
    const name = await screen.findByRole("textbox", { name: "Display name" });
    const slugInput = screen.getByRole("textbox", { name: "Factory slug" });
    await user.type(name, "Default");
    await user.click(screen.getByRole("button", { name: "Create factory" }));
    expect(screen.getByRole("button", { name: "Creating…" })).toBeDisabled();
    await user.keyboard("{Escape}");
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[0]).toBe(`/api/workspaces/${workspaceId}/factories`);
    expect(JSON.parse(fetch.mock.calls[0]?.[1].body)).toEqual({ name: "Default", slug: "default" });

    await act(async () => finish(Response.json({ code: FACTORY_SLUG_TAKEN }, { status: 409 })));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "That factory slug is already reserved",
    );
    expect(slugInput).toHaveValue("default");
    expect(slugInput).toHaveFocus();
    expect(name).toHaveValue("Default");
    expect(push).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();

    await user.clear(slugInput);
    await user.type(slugInput, "internal");
    await user.click(screen.getByRole("button", { name: "Create factory" }));
    expect(JSON.parse(fetch.mock.calls[1]?.[1].body)).toEqual({
      name: "Default",
      slug: "internal",
    });
    expect(push).toHaveBeenCalledWith(
      `/w/northwind/settings?category=workspace&factory=${factoryId}#factory-setup`,
      { scroll: false },
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it.each([
    {
      reason: "network request fails",
      respond: () => Promise.reject(new TypeError("Disconnected")),
    },
    {
      reason: "server returns 503",
      respond: () => Promise.resolve(new Response(null, { status: 503 })),
    },
    {
      reason: "receipt has no factory ID",
      respond: () => Promise.resolve(Response.json({}, { status: 201 })),
    },
  ])("checks the authorized list rather than retrying when the $reason", async ({ respond }) => {
    const fetch = vi.fn(respond);
    vi.stubGlobal("fetch", fetch);
    const { user, trigger } = setup();
    await user.click(trigger);
    const dialog = within(await screen.findByRole("dialog"));
    const name = dialog.getByRole("textbox", { name: "Display name" });
    const slugInput = dialog.getByRole("textbox", { name: "Factory slug" });
    await user.type(name, "Support Ops");
    await user.click(dialog.getByRole("button", { name: "Create factory" }));
    expect(dialog.getByRole("alert")).toHaveTextContent("Couldn’t confirm creation");
    expect(name).toHaveValue("Support Ops");
    expect(slugInput).toHaveValue("support-ops");
    expect(dialog.queryByRole("button", { name: "Create factory" })).not.toBeInTheDocument();

    await user.click(dialog.getByRole("button", { name: "Check factories" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });
});
