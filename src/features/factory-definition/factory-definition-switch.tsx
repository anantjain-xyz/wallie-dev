"use client";

import { useRef, useState, type ComponentProps } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
} from "@/components/ui/alert-dialog";
import { FactorySelector } from "@/features/factories/factory-selector";

export type FactoryDefinitionSelection = Pick<
  ComponentProps<typeof FactorySelector>,
  "factories" | "resetParams" | "selectedValue"
>;

export function FactoryDefinitionSwitch({
  disabled,
  dirty,
  onDiscard,
  selection,
}: {
  disabled: boolean;
  dirty: boolean;
  onDiscard: () => void;
  selection: FactoryDefinitionSelection;
}) {
  const selectorRef = useRef<HTMLDivElement>(null);
  const [target, setTarget] = useState<{ navigate: () => void; label: string } | null>(null);

  return (
    <>
      <div className="min-w-0" ref={selectorRef}>
        <FactorySelector
          {...selection}
          disabled={disabled}
          onSwitch={(navigate, label) => {
            if (dirty) setTarget({ navigate, label });
            else navigate();
          }}
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
            target
              ? `Switching to ${target.label} will discard your unsaved edits here. Saved drafts aren’t affected.`
              : "Switching factories will discard your unsaved edits here."
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            selectorRef.current?.querySelector<HTMLElement>('[role="combobox"]')?.focus();
          }}
          title="Switch factories without saving?"
        >
          <AlertDialogFooter className="flex-wrap">
            <AlertDialogCancel className="ui-button">Stay</AlertDialogCancel>
            <AlertDialogAction
              className="ui-button-danger"
              onClick={() => {
                if (!target) return;
                onDiscard();
                target.navigate();
              }}
            >
              Discard and switch
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
