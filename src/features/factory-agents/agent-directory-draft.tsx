"use client";

import {
  createContext,
  useContext,
  useEffect,
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

const DraftContext = createContext<RefObject<boolean> | null>(null);

export function AgentDirectoryDraftScope({ children }: { children: ReactNode }) {
  const dirtyRef = useRef(false);
  return <DraftContext.Provider value={dirtyRef}>{children}</DraftContext.Provider>;
}

export function useDirectoryDraftStatus(dirty: boolean) {
  const statusRef = useContext(DraftContext);
  useEffect(() => {
    if (!statusRef) return;
    statusRef.current = dirty;
    return () => {
      statusRef.current = false;
    };
  }, [statusRef, dirty]);
}

export function AgentDirectoryFactorySelector({
  factories,
  selectedValue,
}: {
  factories: readonly FactorySelectionOption[];
  selectedValue: string;
}) {
  const dirtyRef = useContext(DraftContext);
  const selector = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ navigate: () => void; label: string } | null>(null);

  return (
    <>
      <div className="min-w-0" ref={selector}>
        <FactorySelector
          factories={factories}
          onSwitch={(navigate, label) => {
            if (dirtyRef?.current) setTarget({ navigate, label });
            else navigate();
          }}
          resetParams={["q"]}
          selectedValue={selectedValue}
        />
      </div>
      <AlertDialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
      >
        <AlertDialogContent
          description={`Switching to ${target?.label ?? "another factory"} will discard your unsaved agent draft.`}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            selector.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
          }}
          title="Switch factories without saving?"
        >
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel className="ui-button">Cancel</AlertDialogCancel>
            <AlertDialogAction className="ui-button-danger" onClick={() => target?.navigate()}>
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
