// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import { CreateFactoryDialog } from "@/features/settings/create-factory-dialog";
import { FACTORY_SLUG_TAKEN } from "@/lib/factories/contracts";

const push = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

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
  vi.unstubAllGlobals();
});

describe("New factory dialog", () => {
  it("suggests a canonical address, respects edits, and returns focus on cancel", async () => {
    const { user, trigger } = setup();
    trigger.focus();
    await user.keyboard("{Enter}");
    const dialog = screen.getByRole("dialog", { name: "New factory" });
    const name = within(dialog).getByRole("textbox", { name: "Factory name" });
    const address = within(dialog).getByRole("textbox", { name: "Address" });
    expect(dialog).toHaveAccessibleDescription(/Northwind/);
    expect(name).toHaveFocus();
    await user.type(name, "Billing + Payments");
    expect(address).toHaveValue("billing-payments");
    await user.clear(address);
    await user.type(address, "billing-team");
    await user.type(name, " Internal");
    expect(address).toHaveValue("billing-team");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "Factory name" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Address" })).toHaveValue("");
  });

  it("validates the edited address instead of silently replacing it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { user, trigger } = setup();
    await user.click(trigger);
    await user.type(screen.getByRole("textbox", { name: "Factory name" }), "Payments");
    const address = screen.getByRole("textbox", { name: "Address" });
    await user.clear(address);
    await user.type(address, "Payments--Team");
    await user.click(screen.getByRole("button", { name: "Create factory" }));
    expect(within(screen.getByRole("dialog")).getByRole("alert")).toHaveTextContent(
      "Use lowercase letters",
    );
    expect(address).toHaveValue("Payments--Team");
    expect(address).toHaveAttribute("aria-invalid", "true");
    expect(address).toHaveFocus();
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
    const name = screen.getByRole("textbox", { name: "Factory name" });
    const address = screen.getByRole("textbox", { name: "Address" });
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
      "That address is already used",
    );
    expect(address).toHaveValue("default");
    expect(address).toHaveFocus();
    expect(name).toHaveValue("Default");
    expect(push).not.toHaveBeenCalled();

    await user.clear(address);
    await user.type(address, "internal");
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
});
