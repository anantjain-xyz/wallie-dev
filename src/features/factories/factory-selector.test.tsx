// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";

const mocked = vi.hoisted(() => ({
  pathname: "/w/acme-corp",
  push: vi.fn(),
  searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => mocked.pathname,
  useRouter: () => ({ push: mocked.push }),
  useSearchParams: () => mocked.searchParams,
}));

const factories: readonly FactorySelectionOption[] = [
  {
    id: "factory-1",
    name: "Default factory",
    isDefault: true,
    status: "active",
    canManage: false,
  },
  {
    id: "factory-2",
    name: "Customer tools",
    isDefault: false,
    status: "active",
    canManage: true,
  },
  {
    id: "factory-3",
    name: "Legacy pipeline",
    isDefault: false,
    status: "archived",
    canManage: false,
  },
];

function renderSelector(options: readonly FactorySelectionOption[] = factories) {
  return render(
    <OverlayProvider>
      <FactorySelector factories={options} workspaceSlug="acme-corp" />
    </OverlayProvider>,
  );
}

beforeEach(() => {
  mocked.pathname = "/w/acme-corp";
  mocked.searchParams = new URLSearchParams();
  mocked.push.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("FactorySelector", () => {
  it("uses the design-system Select dropdown pattern and switches factories", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-1&stage=plan&q=auth&sort=oldest");

    const { container } = renderSelector();

    expect(container.querySelector("select")).toBeNull();

    const trigger = screen.getByRole("combobox", { name: "Factory" });
    expect(trigger).toHaveClass("ui-select-trigger");
    expect(trigger).toHaveTextContent("Default factory");
    expect(trigger).toHaveAttribute("data-value", "factory-1");

    await user.click(trigger);

    const listbox = await screen.findByRole("listbox", { name: "Factory" });
    expect(listbox).toHaveClass("ui-select-content");

    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "All factories",
      "Default factory",
      "Customer tools",
      "Legacy pipeline (archived)",
    ]);
    expect(within(listbox).getByRole("option", { name: "Default factory" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await user.click(within(listbox).getByRole("option", { name: "Customer tools" }));

    expect(mocked.push).toHaveBeenCalledWith(
      "/w/acme-corp/sessions?factory=factory-2&q=auth&sort=oldest",
      { scroll: false },
    );
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  });

  it("does not trigger navigation when re-selecting the active factory", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-1&stage=plan");

    renderSelector();

    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    await user.click(await screen.findByRole("option", { name: "Default factory" }));

    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("omits All factories on single-factory routes and filters managed routes", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/agents";
    mocked.searchParams = new URLSearchParams("factory=factory-2");

    const { unmount } = renderSelector();
    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    expect(
      within(await screen.findByRole("listbox", { name: "Factory" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Default factory", "Customer tools", "Legacy pipeline (archived)"]);
    unmount();

    mocked.pathname = "/w/acme-corp/governance";
    mocked.searchParams = new URLSearchParams();
    renderSelector();
    const trigger = screen.getByRole("combobox", { name: "Factory" });
    expect(trigger).toHaveTextContent("Customer tools");
    await user.click(trigger);
    expect(
      within(await screen.findByRole("listbox", { name: "Factory" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Customer tools"]);
  });

  it("shows Factory unavailable as a disabled option and allows switching away", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=missing-factory");

    renderSelector();

    const trigger = screen.getByRole("combobox", { name: "Factory" });
    expect(trigger).toHaveTextContent("Factory unavailable");
    expect(trigger).toHaveAttribute("data-value", "unavailable");

    await user.click(trigger);
    const listbox = await screen.findByRole("listbox", { name: "Factory" });
    const unavailableOption = within(listbox).getByRole("option", { name: "Factory unavailable" });
    expect(unavailableOption).toHaveAttribute("aria-disabled", "true");
    expect(unavailableOption).toHaveAttribute("aria-selected", "true");

    await user.click(unavailableOption);
    expect(mocked.push).not.toHaveBeenCalled();

    await user.click(within(listbox).getByRole("option", { name: "All factories" }));
    expect(mocked.push).toHaveBeenCalledWith("/w/acme-corp/sessions?factory=all", {
      scroll: false,
    });
  });

  it("supports keyboard navigation and returns focus on Escape", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-1");

    renderSelector();

    const trigger = screen.getByRole("combobox", { name: "Factory" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox", { name: "Factory" })).toBeVisible();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(trigger).toHaveFocus();

    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(mocked.push).toHaveBeenCalledWith("/w/acme-corp/sessions?factory=factory-2", {
      scroll: false,
    });
  });

  it("returns null outside factory-scoped paths", () => {
    mocked.pathname = "/w/acme-corp/sessions/42";
    renderSelector();
    expect(screen.queryByRole("combobox", { name: "Factory" })).toBeNull();
  });
});
