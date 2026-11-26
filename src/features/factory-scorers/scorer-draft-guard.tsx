"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ComponentProps, ReactNode } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
} from "@/components/ui/alert-dialog";

const DraftGuard = createContext<{
  dirty: React.RefObject<boolean>;
  guard: (action: () => void, trigger?: HTMLElement) => void;
} | null>(null);

export function ScorerDraftGuard({ children }: { children: ReactNode }) {
  const dirty = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);

  useEffect(() => {
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirty.current) return;
      event.preventDefault();
      event.returnValue = true;
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, []);

  function guard(action: () => void, source?: HTMLElement) {
    if (!dirty.current) {
      action();
      return;
    }
    trigger.current = source ?? (document.activeElement as HTMLElement | null);
    setPending(() => action);
  }

  return (
    <DraftGuard.Provider value={{ dirty, guard }}>
      {children}
      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent
          title="Discard unpublished edits?"
          description="Your changes to this rubric haven’t been published."
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            trigger.current?.focus();
          }}
        >
          <div className="flex flex-wrap justify-end gap-2">
            <AlertDialogCancel className="ui-button">Keep editing</AlertDialogCancel>
            <AlertDialogAction className="ui-button ui-button-danger" onClick={() => pending?.()}>
              Discard changes
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </DraftGuard.Provider>
  );
}

export function useScorerDraftGuard() {
  return useContext(DraftGuard);
}

export function ScorerDraftLink({
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { href: string }) {
  const draft = useScorerDraftGuard();
  const router = useRouter();
  return (
    <Link
      {...props}
      href={href}
      onNavigate={(event) => {
        if (!draft?.dirty.current) return;
        event.preventDefault();
        draft.guard(() => router.push(href));
      }}
    />
  );
}
