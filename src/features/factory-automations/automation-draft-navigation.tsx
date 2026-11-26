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

type HistoryEntry = { key: string; url: string | null };
type NavigationHistory = EventTarget & {
  currentEntry: HistoryEntry | null;
  traverseTo: (key: string) => { committed: Promise<unknown>; finished: Promise<unknown> };
};
type Destination = { href: string } | { traverse: () => Promise<void> };

function navigationHistory() {
  const history = (window as Window & { navigation?: NavigationHistory }).navigation;
  return typeof history?.traverseTo === "function" ? history : undefined;
}

function sameRoute(from: HistoryEntry, to: HistoryEntry) {
  return (
    from.url !== null && to.url !== null && from.url.split("#", 1)[0] === to.url.split("#", 1)[0]
  );
}

async function traverse(history: NavigationHistory, key: string) {
  const { committed, finished } = history.traverseTo(key);
  await Promise.all([committed, finished]);
}

export function AutomationDraftNavigation({ children }: { children: ReactNode }) {
  const router = useRouter();
  const dirtyRef = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const [dirty, setDirtyState] = useState(false);
  const [destination, setDestination] = useState<Destination | null>(null);
  const [historyNotice, setHistoryNotice] = useState("");

  function setDirty(value: boolean) {
    if (dirtyRef.current === value) return;
    dirtyRef.current = value;
    setDirtyState(value);
    setHistoryNotice(
      value && !navigationHistory()?.currentEntry
        ? "This browser cannot protect Back or Forward. Save your draft before using browser history."
        : "",
    );
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
    setDestination({ href });
  }

  useEffect(() => {
    if (!dirty) return;
    const history = navigationHistory();
    let draftEntry = history?.currentEntry;
    let active = true;
    let returning = 0;
    let request = 0;

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
      setDestination({ href: url.href });
    }

    function updateDraftEntry(event: Event) {
      const type = (event as Event & { navigationType?: string }).navigationType;
      const current = history?.currentEntry;
      if (
        !returning &&
        draftEntry &&
        current &&
        (type === "push" || type === "replace") &&
        sameRoute(draftEntry, current)
      ) {
        draftEntry = current;
      }
    }

    function followHistory(event: PopStateEvent) {
      const target = history?.currentEntry;
      if (!dirtyRef.current || !history || !draftEntry || !target) return;
      if (target.key === draftEntry.key) {
        if (returning) event.stopImmediatePropagation();
        return;
      }
      if (!returning && sameRoute(draftEntry, target)) {
        draftEntry = target;
        return;
      }
      event.stopImmediatePropagation();
      const draftKey = draftEntry.key;
      const attempt = ++request;
      returning = attempt;
      restoreFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDestination(null);
      void traverse(history, draftKey).then(
        () => {
          if (!active || returning !== attempt) return;
          returning = 0;
          if (!dirtyRef.current || history.currentEntry?.key !== draftKey) return;
          setHistoryNotice("");
          setDestination({ traverse: () => traverse(history, target.key) });
        },
        () => {
          if (!active || returning !== attempt) return;
          returning = 0;
          setHistoryNotice(
            "Could not return through browser history. Your edits are still here; save them before leaving.",
          );
        },
      );
    }
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", followLink, true);
    if (history) {
      history.addEventListener("currententrychange", updateDraftEntry);
      window.addEventListener("popstate", followHistory, true);
    }
    return () => {
      active = false;
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", followLink, true);
      history?.removeEventListener("currententrychange", updateDraftEntry);
      window.removeEventListener("popstate", followHistory, true);
    };
  }, [dirty]);

  return (
    <DraftNavigation.Provider value={{ setDirty, navigate }}>
      {children}
      {historyNotice ? (
        <p role="status" className="px-4 py-3 text-sm text-muted">
          {historyNotice}
        </p>
      ) : null}
      <DestructiveConfirmationDialog
        actionLabel="Discard changes"
        cancelLabel="Keep editing"
        description="Your unsaved rule changes will be lost. Saved revisions are not affected."
        onConfirm={() => {
          if (!destination) return;
          setDirty(false);
          setDestination(null);
          if ("href" in destination) {
            go(destination.href);
          } else {
            void destination.traverse().catch(() => {
              setDirty(true);
              setHistoryNotice(
                "Could not move through browser history. Your edits are still here.",
              );
            });
          }
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
