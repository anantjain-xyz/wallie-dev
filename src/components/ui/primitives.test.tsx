// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Dialog, DialogClose, DialogContent, DialogTrigger } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLiveRegion } from "@/components/ui/live-region";
import { OverlayProvider } from "@/components/ui/overlay-provider";
import {
  Select,
  SelectContent,
  SelectField,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";
import { useToast } from "@/components/ui/toast";
import { Tooltip } from "@/components/ui/tooltip";
import { UiPrimitivesShowcase } from "@/components/ui/ui-primitives-showcase";

beforeAll(() => {
  class ResizeObserverStub {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
  vi.stubGlobal("PointerEvent", MouseEvent);
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      addEventListener: vi.fn(),
      matches: query.includes("reduce"),
      media: query,
      removeEventListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  document.body.removeAttribute("data-scroll-locked");
  document.body.removeAttribute("style");
  document.documentElement.dataset.theme = "light";
  delete document.documentElement.dataset.reducedMotion;
});

function renderWithOverlays(children: React.ReactNode) {
  return render(<OverlayProvider>{children}</OverlayProvider>);
}

describe("accessible overlay primitives", () => {
  it("traps dialog focus, inerts and locks the background, then restores focus", async () => {
    const user = userEvent.setup();

    renderWithOverlays(
      <div data-testid="application">
        <Dialog>
          <DialogTrigger asChild>
            <button type="button">Open profile</button>
          </DialogTrigger>
          <DialogContent description="Update the visible name." title="Edit profile">
            <label>
              Display name
              <input defaultValue="Wallie" />
            </label>
            <DialogClose asChild>
              <button type="button">Save profile</button>
            </DialogClose>
          </DialogContent>
        </Dialog>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Open profile" });
    await user.click(trigger);

    expect(await screen.findByRole("dialog", { name: "Edit profile" })).toBeTruthy();
    await waitFor(() => expect(screen.getByLabelText("Display name")).toHaveFocus());
    await waitFor(() => expect(document.body.dataset.scrollLocked).toBe("1"));
    expect(screen.getByTestId("application").closest("[aria-hidden='true']")).toBeTruthy();

    await user.tab({ shift: true });
    expect(document.activeElement).not.toBe(document.body);
    expect(screen.getByRole("dialog").contains(document.activeElement)).toBe(true);

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("keeps an alert dialog open on outside interaction and restores focus on Escape", async () => {
    const user = userEvent.setup();

    renderWithOverlays(
      <div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <button type="button">Remove workspace</button>
          </AlertDialogTrigger>
          <AlertDialogContent description="This cannot be undone." title="Remove this workspace?">
            <AlertDialogCancel>Cancel removal</AlertDialogCancel>
            <AlertDialogAction>Remove permanently</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
        <button type="button">Outside</button>
      </div>,
    );

    const trigger = screen.getByRole("button", { name: "Remove workspace" });
    await user.click(trigger);
    expect(await screen.findByRole("alertdialog", { name: "Remove this workspace?" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Cancel removal" })).toHaveFocus(),
    );

    fireEvent.pointerDown(screen.getByText("Outside"));
    expect(screen.getByRole("alertdialog")).toBeTruthy();

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("supports menu arrows, Home/End, typeahead, and Escape", async () => {
    const user = userEvent.setup();

    renderWithOverlays(
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button">Actions</button>
        </DropdownMenuTrigger>
        <DropdownMenuContent label="Issue actions">
          <DropdownMenuItem>Archive</DropdownMenuItem>
          <DropdownMenuItem>Duplicate</DropdownMenuItem>
          <DropdownMenuItem>Move</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );

    const trigger = screen.getByRole("button", { name: "Actions" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    const menu = await screen.findByRole("menu", { hidden: true });
    expect(menu).toHaveAccessibleName("Actions");
    expect(menu).toHaveAttribute("aria-label", "Issue actions");
    expect(menu?.closest("[aria-hidden='true']")).toBeNull();
    expect(screen.getByRole("menuitem", { hidden: true, name: "Archive" })).toHaveFocus();

    await user.keyboard("{End}");
    expect(screen.getByRole("menuitem", { hidden: true, name: "Move" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("menuitem", { hidden: true, name: "Archive" })).toHaveFocus();
    await user.keyboard("d");
    expect(screen.getByRole("menuitem", { hidden: true, name: "Duplicate" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.querySelector("[role='menu']")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("supports Select arrows, Home/End, typeahead, selection, and Escape", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    renderWithOverlays(
      <Select defaultValue="plan" onValueChange={onValueChange}>
        <SelectTrigger accessibleLabel="Stage" />
        <SelectContent>
          <SelectItem value="plan">Plan</SelectItem>
          <SelectItem value="build">Build</SelectItem>
          <SelectItem value="land">Land</SelectItem>
        </SelectContent>
      </Select>,
    );

    const trigger = screen.getByRole("combobox", { name: "Stage" });
    trigger.focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findByRole("listbox")).toBeTruthy();
    await user.keyboard("{End}");
    expect(screen.getByRole("option", { name: "Land" })).toHaveFocus();
    await user.keyboard("{Home}");
    expect(screen.getByRole("option", { name: "Plan" })).toHaveFocus();
    await user.keyboard("b{Enter}");
    expect(onValueChange).toHaveBeenCalledWith("build");

    await user.keyboard("{ArrowDown}{Escape}");
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it("preserves SelectField empty-string options behind the Radix boundary", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();

    renderWithOverlays(
      <SelectField
        emptyOption={{ label: "No provider", value: "" }}
        label="Agent provider"
        onValueChange={onValueChange}
        options={[{ label: "Codex", value: "codex" }]}
        value="codex"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Agent provider" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "No provider" }));
    expect(onValueChange).toHaveBeenCalledWith("");
  });

  it("reveals supplementary tooltip content on keyboard focus without title attributes", async () => {
    const user = userEvent.setup();

    renderWithOverlays(
      <Tooltip content="Supplementary help" delayDuration={0}>
        <button aria-label="Help" type="button">
          ?
        </button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "Help" });
    expect(trigger.hasAttribute("title")).toBe(false);
    await user.tab();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Supplementary help");
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("tooltip")).toBeNull());
  });

  it("routes routine and urgent async status through polite and assertive strategies", async () => {
    const user = userEvent.setup();

    function Notices() {
      const { announce } = useLiveRegion();
      const { pushToast } = useToast();

      return (
        <>
          <button onClick={() => announce("Sync complete", "polite")} type="button">
            Announce sync
          </button>
          <button
            onClick={() =>
              pushToast({ priority: "assertive", title: "Connection failed", tone: "danger" })
            }
            type="button"
          >
            Announce failure
          </button>
        </>
      );
    }

    renderWithOverlays(<Notices />);
    await user.click(screen.getByRole("button", { name: "Announce sync" }));
    await waitFor(() =>
      expect(document.querySelector("[data-live-region='polite']")).toHaveTextContent(
        "Sync complete",
      ),
    );
    await user.click(screen.getByRole("button", { name: "Announce failure" }));
    expect(await screen.findByText("Connection failed")).toBeTruthy();
  });

  it("exercises light, dark, and reduced-motion display states", async () => {
    const user = userEvent.setup();
    renderWithOverlays(<UiPrimitivesShowcase />);

    await user.click(screen.getByRole("button", { name: "Dark" }));
    await waitFor(() => expect(document.documentElement.dataset.theme).toBe("dark"));
    await user.click(screen.getByRole("button", { name: "Reduced motion" }));
    await waitFor(() => expect(document.documentElement.dataset.reducedMotion).toBe("reduce"));
  });

  it("has no detectable axe violations across the primitive showcase and open dialog", async () => {
    const user = userEvent.setup();
    renderWithOverlays(<UiPrimitivesShowcase />);

    const axeOptions = { rules: { "color-contrast": { enabled: false } } };
    let results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Edit workspace" }));
    await screen.findByRole("dialog", { name: "Edit workspace" });
    results = await axe.run(document.body, axeOptions);
    expect(results.violations).toEqual([]);
  });

  it("keeps live-region announcements audible while a modal dialog is open", async () => {
    const user = userEvent.setup();

    function Notices() {
      const { announce } = useLiveRegion();
      const { pushToast } = useToast();
      return (
        <>
          <Dialog>
            <DialogTrigger asChild>
              <button type="button">Open modal</button>
            </DialogTrigger>
            <DialogContent description="Modal is open." title="Modal">
              <DialogClose asChild>
                <button type="button">Close</button>
              </DialogClose>
            </DialogContent>
          </Dialog>
          <button onClick={() => announce("Saved while modal open", "polite")} type="button">
            Announce
          </button>
          <button
            onClick={() =>
              pushToast({ priority: "assertive", title: "Failed while modal open", tone: "danger" })
            }
            type="button"
          >
            Toast
          </button>
        </>
      );
    }

    renderWithOverlays(<Notices />);
    const announceButton = screen.getByRole("button", { name: "Announce", hidden: true });
    await user.click(screen.getByRole("button", { name: "Open modal" }));
    await screen.findByRole("dialog", { name: "Modal" });

    await user.click(announceButton);
    const politeRegion = await waitFor(() => document.querySelector("[data-live-region='polite']"));
    expect(politeRegion?.closest("[aria-hidden='true']")).toBeNull();
    await waitFor(() => expect(politeRegion).toHaveTextContent("Saved while modal open"));

    const assertiveRegion = document.querySelector("[data-live-region='assertive']");
    expect(assertiveRegion?.closest("[aria-hidden='true']")).toBeNull();
  });

  it("truncates long SelectField values so the trigger does not overflow", () => {
    const longLabel =
      "anantjain-xyz/wallie-dev-very-long-repository-full-name-that-exceeds-the-trigger";
    renderWithOverlays(
      <SelectField
        label="Repository"
        onValueChange={() => {}}
        options={[{ label: longLabel, value: "repo" }]}
        value="repo"
      />,
    );

    const trigger = screen.getByRole("combobox", { name: "Repository" });
    const valueText = trigger.querySelector(".min-w-0.truncate");
    expect(valueText).not.toBeNull();
    expect(valueText).toHaveClass("truncate");
    expect(valueText).toHaveClass("min-w-0");
  });
});
