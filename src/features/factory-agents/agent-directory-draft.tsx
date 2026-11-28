"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import type { FactorySelectionOption } from "@/features/factories/factory-selection";
import { FactorySelector } from "@/features/factories/factory-selector";

const DraftContext = createContext<{
  dirty: RefObject<boolean>;
  busy: boolean;
  setBusy: (busy: boolean) => void;
} | null>(null);

export function AgentDirectoryDraftScope({ children }: { children: ReactNode }) {
  const dirtyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  return (
    <DraftContext.Provider value={{ busy, dirty: dirtyRef, setBusy }}>
      {children}
    </DraftContext.Provider>
  );
}

export function useDirectoryDraftStatus(dirty: boolean, busy = false) {
  const { dirty: statusRef, setBusy } = useContext(DraftContext) ?? {};
  useLayoutEffect(() => {
    if (statusRef) statusRef.current = dirty;
    return () => {
      if (statusRef) statusRef.current = false;
    };
  }, [statusRef, dirty]);
  useLayoutEffect(() => {
    setBusy?.(busy);
    return () => setBusy?.(false);
  }, [setBusy, busy]);
}

export function AgentDirectoryFactorySelector({
  factories,
  selectedValue,
}: {
  factories: readonly FactorySelectionOption[];
  selectedValue: string;
}) {
  const draft = useContext(DraftContext);
  const trigger = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<{ navigate: () => void; label?: string } | null>(null);
  const leaving = target !== null && target.label === undefined;

  function guard(navigate: () => void, label?: string) {
    if (draft?.dirty.current) setTarget({ navigate, label });
    else navigate();
  }

  return (
    <>
      <div className="min-w-0">
        <FactorySelector
          factories={factories}
          manageDisabled={draft?.busy}
          onManage={guard}
          onSwitch={guard}
          resetParams={["q", "new"]}
          selectedValue={selectedValue}
          triggerRef={trigger}
        />
      </div>
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <AlertDialogContent
          description={
            leaving
              ? "Leaving this page will discard your unsaved agent draft."
              : `Switching to ${target?.label ?? "another factory"} will discard your unsaved agent draft.`
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          title={leaving ? "Leave without saving?" : "Switch factories without saving?"}
        >
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel className="ui-button">Cancel</AlertDialogCancel>
            <AlertDialogAction className="ui-button-danger" onClick={() => target?.navigate()}>
              {leaving ? "Discard and leave" : "Discard and switch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
