"use client";

import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { SelectField } from "@/components/ui/select";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { workspaceAutomationPreviewPath } from "@/lib/routes";

const DraftNavigation = createContext<{
  setDirty: (value: boolean) => void;
  navigate: (href: string) => void;
}>({
  setDirty: () => undefined,
  navigate: () => undefined,
});

export const useAutomationDraftNavigation = () => useContext(DraftNavigation);

export function AutomationDraftNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const dirtyRef = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [destination, setDestination] = useState<string | null>(null);

  function setDirty(value: boolean) {
    dirtyRef.current = value;
    setDirtyState(value);
  }

  function go(href: string) {
    const url = new URL(href, window.location.href);
    if (url.origin === window.location.origin) {
      router.push(url.pathname + url.search + url.hash);
    } else {
      window.location.assign(url.href);
    }
  }

  function navigate(href: string) {
    if (new URL(href, window.location.href).href === window.location.href) return;
    if (!dirtyRef.current) {
      go(href);
      return;
    }
    restoreFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDestination(href);
  }

  useEffect(() => {
    if (!dirty) return;
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    }
    function followLink(event: MouseEvent) {
      if (
        !dirtyRef.current ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      )
        return;
      const link = event.target.closest<HTMLAnchorElement>("a[href]");
      if (!link || (link.target && link.target !== "_self") || link.hasAttribute("download"))
        return;
      const url = new URL(link.href);
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (
        url.origin === window.location.origin &&
        url.pathname === window.location.pathname &&
        url.search === window.location.search
      )
        return;
      event.preventDefault();
      restoreFocus.current = link;
      setDestination(url.href);
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
    };
  }, [dirty]);

  return (
    <DraftNavigation.Provider value={{ setDirty, navigate }}>
      {children}
      <DestructiveConfirmationDialog
        actionLabel="Discard changes"
        cancelLabel="Keep editing"
        description="Your unsaved rule changes will be lost. Saved revisions are not affected."
        onConfirm={() => {
          if (!destination) return;
          setDirty(false);
          setDestination(null);
          go(destination);
        }}
        onOpenChange={(open) => {
          if (!open) setDestination(null);
        }}
        open={destination !== null}
        pending={false}
        pendingLabel="Leaving…"
        restoreFocusRef={restoreFocus}
        title="Discard unsaved changes?"
      />
    </DraftNavigation.Provider>
  );
}

export function AutomationFactoryPicker({
  factoryId,
  factories,
  workspaceSlug,
}: {
  factoryId: string;
  factories: readonly FactorySelectionOption[];
  workspaceSlug: string;
}) {
  const { navigate } = useAutomationDraftNavigation();
  return (
    <SelectField
      className="w-48 max-w-full"
      label="Factory"
      onValueChange={(factory) => {
        if (factory !== factoryId)
          navigate(workspaceAutomationPreviewPath(workspaceSlug, { factory }));
      }}
      options={factories.map(({ id, name }) => ({ value: id, label: name }))}
      value={factoryId}
      wrap
    />
  );
}

export function AutomationRulePicker({
  selectedId,
  options,
  workspaceSlug,
  factoryId,
  afterId,
}: {
  selectedId?: string;
  options: { value: string; label: string }[];
  workspaceSlug: string;
  factoryId: string;
  afterId?: string;
}) {
  const { navigate } = useAutomationDraftNavigation();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const automation = new FormData(event.currentTarget).get("automation");
        if (typeof automation === "string" && options.some(({ value }) => value === automation)) {
          navigate(
            workspaceAutomationPreviewPath(workspaceSlug, {
              factory: factoryId,
              afterId,
              automation,
            }),
          );
        }
      }}
      className="grid min-w-0 items-end gap-2 sm:grid-cols-[minmax(0,1fr)_auto]"
    >
      <SelectField
        label="Automation"
        name="automation"
        defaultValue={selectedId}
        required
        wrap
        options={options}
      />
      <button className="ui-button w-fit" type="submit">
        Open automation
      </button>
    </form>
  );
}
