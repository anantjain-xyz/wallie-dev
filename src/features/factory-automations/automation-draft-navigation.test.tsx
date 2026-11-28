// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import Link from "next/link";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { WorkspaceScopeContext } from "@/components/app-shell/workspace-scope-context";
import { PortalRootProvider } from "@/components/ui/portal-root";

import {
  AutomationDraftNavigation,
  AutomationFactoryPicker,
  AutomationRulePicker,
  useAutomationDraftNavigation,
} from "./automation-draft-navigation";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/w/example/settings/automations",
  useRouter: () => ({ push }),
  useSearchParams: () =>
    new URLSearchParams(
      "factory=current&automation=rule&historyBefore=earlier&historyBeforeId=event&afterId=older&q=keep",
    ),
}));

const observePopstate = vi.fn();

function Example() {
  const { setDirty } = useAutomationDraftNavigation();
  return (
    <>
      <input aria-label="Draft name" onChange={() => setDirty(true)} />
      <button type="button" onClick={() => setDirty(false)}>
        Mark saved
      </button>
      <Link href="/w/example/settings" prefetch={false}>
        Back to Settings
      </Link>
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
        resetParams={["automation", "historyBefore", "historyBeforeId"]}
      />
    </>
  );
}

function ExampleShell() {
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  return (
    <WorkspaceScopeContext.Provider
      value={{ guardedPicker: { target }, ownsPicker: false, publish: () => () => undefined }}
    >
      <header>
        <div ref={setTarget} />
      </header>
      <main>
        <AutomationDraftNavigation>
          <Example />
        </AutomationDraftNavigation>
      </main>
    </WorkspaceScopeContext.Provider>
  );
}

function setup() {
  render(
    <PortalRootProvider>
      <ExampleShell />
    </PortalRootProvider>,
  );
  return userEvent.setup();
}

function setupHistory() {
  const draftUrl = "https://wallie.test/w/example/settings/automations?automation=rule";
  const urls = {
    back: "https://wallie.test/w/example/settings",
    draft: draftUrl,
    hash: `${draftUrl}#history`,
    forward: "https://wallie.test/w/example/settings/automations?automation=another",
  };
  type Key = keyof typeof urls;
  function move(key: Key) {
    history.currentEntry = { key, url: urls[key] };
    window.dispatchEvent(new PopStateEvent("popstate", { state: key }));
  }
  function requestTraversal(key: Key) {
    const event = Object.assign(new Event("navigate", { cancelable: true }), {
      destination: { key, url: urls[key], sameDocument: true },
      navigationType: "traverse",
    });
    if (history.dispatchEvent(event)) move(key);
    return event;
  }
  const history = Object.assign(new EventTarget(), {
    currentEntry: { key: "draft" as Key, url: urls.draft },
    traverseTo: vi.fn(asyncMove),
    move,
    requestTraversal,
    pushHash() {
      history.currentEntry = { key: "hash", url: urls.hash };
      history.dispatchEvent(
        Object.assign(new Event("currententrychange"), { navigationType: "push" }),
      );
    },
  });
  function asyncMove(key: Key) {
    const committed = Promise.resolve().then(() => move(key));
    return { committed, finished: committed };
  }

  vi.stubGlobal("navigation", history);
  window.addEventListener("popstate", observePopstate);
  return history;
}

afterEach(() => {
  cleanup();
  window.removeEventListener("popstate", observePopstate);
  observePopstate.mockReset();
  vi.unstubAllGlobals();
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

  const trigger = within(screen.getByRole("banner")).getByRole("combobox", { name: "Factory" });
  async function chooseAlternate() {
    await user.click(trigger);
    await user.click(screen.getByRole("option", { name: "Alternate" }));
    return screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
  }
  dialog = await chooseAlternate();
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(trigger).toHaveFocus());
  await chooseAlternate();
  await user.keyboard("{Escape}");
  await waitFor(() => expect(trigger).toHaveFocus());
  expect(trigger).toHaveTextContent("Current");
  expect(screen.getByRole("textbox", { name: "Draft name" })).toHaveValue("Unsaved edits");
  expect(push).not.toHaveBeenCalled();

  dialog = await chooseAlternate();
  await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
  expect(push).toHaveBeenCalledExactlyOnceWith(
    "/w/example/settings/automations?factory=alternate&q=keep",
    { scroll: false },
  );
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

it.each(["back", "forward"] as const)(
  "protects a dirty draft on browser %s and replays the exact history entry after discard",
  async (target) => {
    const history = setupHistory();
    const user = setup();
    await act(async () => {
      history.move(target);
      history.move("draft");
    });
    expect(observePopstate.mock.calls.map(([event]) => event.state)).toEqual([target, "draft"]);
    expect(history.traverseTo).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    observePopstate.mockClear();

    const draft = screen.getByRole("textbox", { name: "Draft name" });
    await user.type(draft, "Unsaved edits");
    await act(async () => history.move(target));
    let dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    expect(history.currentEntry.key).toBe("draft");
    expect(observePopstate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
    expect(draft).toHaveValue("Unsaved edits");

    await act(async () => history.move(target));
    dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(history.currentEntry.key).toBe(target);
    expect(observePopstate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ state: target }),
    );
    expect(history.traverseTo.mock.calls).toEqual([["draft"], ["draft"], [target]]);
    expect(push).not.toHaveBeenCalled();
  },
);

it.each(["back", "forward"] as const)(
  "stops a cancelable browser %s before it can replace the editor and replays only on discard",
  async (target) => {
    const history = setupHistory();
    const user = setup();
    const draft = screen.getByRole("textbox", { name: "Draft name" });
    await user.type(draft, "Unsaved edits");

    await act(async () => {
      expect(history.requestTraversal(target).defaultPrevented).toBe(true);
    });
    expect(history.currentEntry.key).toBe("draft");
    expect(observePopstate).not.toHaveBeenCalled();
    expect(history.traverseTo).not.toHaveBeenCalled();
    await screen.findByRole("alertdialog");
    await user.keyboard("{Escape}");
    expect(draft).toHaveValue("Unsaved edits");
    expect(history.currentEntry.key).toBe("draft");

    await act(async () => {
      expect(history.requestTraversal(target).defaultPrevented).toBe(true);
    });
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Discard changes" }));
    expect(history.currentEntry.key).toBe(target);
    expect(history.traverseTo).toHaveBeenCalledExactlyOnceWith(target);
    expect(observePopstate).toHaveBeenCalledTimes(1);
  },
);

it("allows hash-only history and returns to the exact draft entry after a hash push", async () => {
  const history = setupHistory();
  const user = setup();
  const draft = screen.getByRole("textbox", { name: "Draft name" });
  await user.type(draft, "Unsaved edits");

  await act(async () => {
    history.pushHash();
    history.move("draft");
  });
  expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  expect(history.traverseTo).not.toHaveBeenCalled();

  await act(async () => {
    history.pushHash();
    history.move("back");
  });
  const dialog = await screen.findByRole("alertdialog", { name: "Discard unsaved changes?" });
  await user.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  expect(history.currentEntry.key).toBe("hash");
  expect(history.traverseTo).toHaveBeenCalledExactlyOnceWith("hash");
  expect(draft).toHaveValue("Unsaved edits");
});
