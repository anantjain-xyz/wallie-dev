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
  const trigger = useRef<HTMLButtonElement>(null);
  const [target, setTarget] = useState<{ navigate: () => void; label?: string } | null>(null);
  const leaving = target !== null && target.label === undefined;

  function guard(navigate: () => void, label?: string) {
    if (dirty) setTarget({ navigate, label });
    else navigate();
  }

  return (
    <>
      <div className="min-w-0">
        <FactorySelector
          {...selection}
          disabled={disabled}
          triggerRef={trigger}
          onManage={guard}
          onSwitch={guard}
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
              ? "Leaving this page will discard your unsaved edits. Saved drafts aren’t affected."
              : target
                ? `Switching to ${target.label} will discard your unsaved edits here. Saved drafts aren’t affected.`
                : "Switching factories will discard your unsaved edits here."
          }
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
          title={leaving ? "Leave without saving?" : "Switch factories without saving?"}
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
              {leaving ? "Discard and leave" : "Discard and switch"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
