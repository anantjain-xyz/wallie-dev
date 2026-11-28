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
import { BackLink } from "@/components/ui/back-link";

const DraftGuard = createContext<{
  busy: boolean;
  dirty: React.RefObject<boolean>;
  guard: (action: () => void, trigger?: HTMLElement) => void;
  setBusy: (busy: boolean) => void;
} | null>(null);

export function ScorerDraftGuard({ children }: { children: ReactNode }) {
  const dirty = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState<(() => void) | null>(null);
  const [busy, setBusy] = useState(false);

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
    <DraftGuard.Provider value={{ busy, dirty, guard, setBusy }}>
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
  back = false,
  href,
  ...props
}: Omit<ComponentProps<typeof Link>, "href" | "onNavigate"> & { back?: boolean; href: string }) {
  const draft = useScorerDraftGuard();
  const router = useRouter();
  const DraftLink = back ? BackLink : Link;
  return (
    <DraftLink
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
