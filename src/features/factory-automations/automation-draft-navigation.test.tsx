// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";

import {
  AutomationDraftNavigation,
  AutomationFactoryPicker,
  AutomationRulePicker,
  useAutomationDraftNavigation,
} from "./automation-draft-navigation";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

function Example() {
  const { setDirty } = useAutomationDraftNavigation();
  return (
    <>
      <input aria-label="Draft name" onChange={() => setDirty(true)} />
      <button type="button" onClick={() => setDirty(false)}>
        Mark saved
      </button>
      <a href="/w/example/settings">Back to Settings</a>
      <AutomationRulePicker
        factoryId="current"
        selectedId="rule"
        options={[{ value: "rule", label: "Release alerts" }]}
        workspaceSlug="example"
      />
      <AutomationFactoryPicker
        factoryId="current"
        factories={[
          { id: "current", name: "Current", status: "active", isDefault: true },
          { id: "alternate", name: "Alternate", status: "active", isDefault: false },
        ]}
        workspaceSlug="example"
      />
    </>
  );
}

function setup() {
  render(
    <PortalRootProvider>
      <AutomationDraftNavigation>
        <Example />
      </AutomationDraftNavigation>
    </PortalRootProvider>,
  );
  return userEvent.setup();
}

afterEach(() => {
  cleanup();
  push.mockReset();
});

it("keeps edits on cancel and clears scope only after the manager discards", async () => {
  const user = setup();
  await user.type(screen.getByRole("textbox", { name: "Draft name" }), "Unsaved edits");

  const settings = screen.getByRole("link", { name: "Back to Settings" });
  await user.click(settings);
  let dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(screen.getByRole("textbox", { name: "Draft name" })).toHaveValue("Unsaved edits");
  expect(push).not.toHaveBeenCalled();

  await user.click(screen.getByRole("combobox", { name: "Factory" }));
  await user.click(screen.getByRole("option", { name: "Alternate" }));
  dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
  await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
  expect(push).toHaveBeenCalledExactlyOnceWith("/w/example/settings/automations?factory=alternate");
});

it("warns on unload while dirty and opens the rule without a dialog after save", async () => {
  const user = setup();
  await user.type(screen.getByRole("textbox", { name: "Draft name" }), "Unsaved edits");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);

  await user.click(screen.getByRole("button", { name: "Mark saved" }));
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  await user.click(screen.getByRole("button", { name: "Open automation" }));
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(push).toHaveBeenCalledExactlyOnceWith(
    "/w/example/settings/automations?factory=current&automation=rule",
  );
});
