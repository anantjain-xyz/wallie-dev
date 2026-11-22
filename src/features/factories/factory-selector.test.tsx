// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";

const mocked = vi.hoisted(() => ({
  pathname: "/w/acme-corp/sessions",
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

function renderSelector({
  allowAll = false,
  options = factories,
  resetParams,
  selectedValue = "factory-1",
}: {
  allowAll?: boolean;
  options?: readonly FactorySelectionOption[];
  resetParams?: readonly string[];
  selectedValue?: string;
} = {}) {
  return render(
    <OverlayProvider>
      <FactorySelector
        allowAll={allowAll}
        factories={options}
        resetParams={resetParams}
        selectedValue={selectedValue}
      />
    </OverlayProvider>,
  );
}

beforeEach(() => {
  mocked.pathname = "/w/acme-corp/sessions";
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

    const { container } = renderSelector({ allowAll: true, selectedValue: "factory-1" });

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

  it("resets declared page-specific query params when switching factories", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/analytics";
    mocked.searchParams = new URLSearchParams(
      "factory=factory-1&dimension=agent&routingCanary=old&metric=flow",
    );

    renderSelector({
      resetParams: ["metric", "routingCanary"],
      selectedValue: "factory-1",
    });

    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    await user.click(
      within(await screen.findByRole("listbox", { name: "Factory" })).getByRole("option", {
        name: "Customer tools",
      }),
    );

    expect(mocked.push).toHaveBeenCalledWith(
      "/w/acme-corp/analytics?factory=factory-2&dimension=agent",
      { scroll: false },
    );
  });

  it("does not trigger navigation when re-selecting the active factory", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-1&stage=plan");

    renderSelector({ allowAll: true, selectedValue: "factory-1" });

    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    await user.click(await screen.findByRole("option", { name: "Default factory" }));

    expect(mocked.push).not.toHaveBeenCalled();
  });

  it("omits All factories when allowAll is false and renders only the passed factories", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/agents";

    const { unmount } = renderSelector({ selectedValue: "factory-2" });
    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    expect(
      within(await screen.findByRole("listbox", { name: "Factory" }))
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["Default factory", "Customer tools", "Legacy pipeline (archived)"]);
    unmount();

    mocked.pathname = "/w/acme-corp/governance";
    const managed = factories.filter(({ canManage }) => canManage);
    renderSelector({ options: managed, selectedValue: "factory-2" });
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

    renderSelector({ allowAll: true, selectedValue: "unavailable" });

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

  it("falls back to Factory unavailable if selectedValue is not permitted by allowAll or options", () => {
    renderSelector({ allowAll: false, selectedValue: "all" });

    const trigger = screen.getByRole("combobox", { name: "Factory" });
    expect(trigger).toHaveTextContent("Factory unavailable");
    expect(trigger).toHaveAttribute("data-value", "unavailable");
  });

  it("supports keyboard navigation and returns focus on Escape", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-1");

    renderSelector({ allowAll: true, selectedValue: "factory-1" });

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

  it("allows long factory names and archived markers to wrap instead of clipping in the listbox", async () => {
    const user = userEvent.setup();
    mocked.pathname = "/w/acme-corp/sessions";
    mocked.searchParams = new URLSearchParams("factory=factory-prod");

    renderSelector({
      allowAll: true,
      options: [
        {
          id: "factory-prod",
          name: "Customer tools — production environment",
          isDefault: true,
          status: "active",
        },
        {
          id: "factory-prod-archived",
          name: "Customer tools — production environment",
          isDefault: false,
          status: "archived",
        },
      ],
      selectedValue: "factory-prod",
    });

    await user.click(screen.getByRole("combobox", { name: "Factory" }));
    const listbox = await screen.findByRole("listbox", { name: "Factory" });
    expect(listbox).toHaveClass("w-max");

    const archivedOption = within(listbox).getByRole("option", {
      name: "Customer tools — production environment (archived)",
    });
    expect(archivedOption.querySelector(".truncate")).toBeNull();
    expect(archivedOption.querySelector(".break-words")).toHaveClass("whitespace-normal");
  });
});
