// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OverlayProvider } from "@/components/ui/overlay-provider";
import {
  SettingsDirtyRegistryProvider,
  useRegisterSettingsDirtySource,
  useSettingsHasUnsavedChanges,
} from "@/features/settings/settings-dirty-registry";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.history.replaceState(null, "", "/");
});

function DirtyProbe({ canEdit, isDirty }: { canEdit: boolean; isDirty: boolean }) {
  useRegisterSettingsDirtySource("probe", isDirty, canEdit);
  const dirty = useSettingsHasUnsavedChanges();
  return <div data-testid="dirty">{dirty ? "dirty" : "clean"}</div>;
}

describe("SettingsDirtyRegistry", () => {
  it("tracks editable dirty sources and ignores read-only dirty state", () => {
    const { rerender } = render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
      </SettingsDirtyRegistryProvider>,
    );
    expect(screen.getByTestId("dirty")).toHaveTextContent("dirty");

    rerender(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit={false} isDirty />
      </SettingsDirtyRegistryProvider>,
    );
    expect(screen.getByTestId("dirty")).toHaveTextContent("clean");
  });

  it("prompts beforeunload only while editable values differ from the server projection", () => {
    render(
      <OverlayProvider>
        <SettingsDirtyRegistryProvider>
          <DirtyProbe canEdit isDirty />
        </SettingsDirtyRegistryProvider>
      </OverlayProvider>,
    );

    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    Object.defineProperty(event, "returnValue", { configurable: true, value: "", writable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("does not prompt after successful save clears dirty state", () => {
    const { rerender } = render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
      </SettingsDirtyRegistryProvider>,
    );

    rerender(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty={false} />
      </SettingsDirtyRegistryProvider>,
    );

    const event = new Event("beforeunload", { cancelable: true }) as BeforeUnloadEvent;
    Object.defineProperty(event, "returnValue", { configurable: true, value: "", writable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("prompts for hash links that change settings category while dirty", () => {
    window.history.replaceState(null, "", "/w/acme/settings/agent-execution");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
        <a href="#vercel">Open Vercel</a>
      </SettingsDirtyRegistryProvider>,
    );

    const anchor = screen.getByRole("link", { name: "Open Vercel" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);

    expect(confirmSpy).toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });

  it("allows same-category hash links without prompting", () => {
    window.history.replaceState(null, "", "/w/acme/settings/integrations");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);

    render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
        <a href="#github">Open GitHub</a>
      </SettingsDirtyRegistryProvider>,
    );

    const anchor = screen.getByRole("link", { name: "Open GitHub" });
    const event = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.dispatchEvent(event);

    expect(confirmSpy).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("prompts on popstate history navigation while dirty and restores when cancelled", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const goSpy = vi.spyOn(window.history, "go").mockImplementation(() => undefined);

    render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
      </SettingsDirtyRegistryProvider>,
    );

    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(confirmSpy).toHaveBeenCalled();
    expect(goSpy).toHaveBeenCalledWith(1);
  });

  it("allows popstate navigation after confirming leave", () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const goSpy = vi.spyOn(window.history, "go").mockImplementation(() => undefined);

    render(
      <SettingsDirtyRegistryProvider>
        <DirtyProbe canEdit isDirty />
      </SettingsDirtyRegistryProvider>,
    );

    window.dispatchEvent(new PopStateEvent("popstate"));

    expect(confirmSpy).toHaveBeenCalled();
    expect(goSpy).not.toHaveBeenCalled();
  });
});
