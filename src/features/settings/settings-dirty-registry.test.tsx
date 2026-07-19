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
});
