"use client";

import { useRef, useState, type FocusEvent, type KeyboardEvent } from "react";

import { LogoutIcon } from "@/components/shared/icons";

type AccountMenuProps = {
  email: string | null;
};

export function AccountMenu({ email }: AccountMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const initial = (email?.trim().charAt(0) ?? "").toUpperCase() || "?";
  const triggerLabel = email ? `Account: ${email}` : "Account";

  // Mirror the SelectField dismissal pattern: a blur that lands outside the
  // wrapper closes the menu, so a click anywhere else on the page collapses it.
  function handleBlur(event: FocusEvent<HTMLDivElement>) {
    const nextFocusedElement = event.relatedTarget;

    if (
      !(nextFocusedElement instanceof Node) ||
      !event.currentTarget.contains(nextFocusedElement)
    ) {
      setIsOpen(false);
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === "Escape" && isOpen) {
      event.preventDefault();
      setIsOpen(false);
      triggerRef.current?.focus();
    }
  }

  return (
    <div className="relative" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        className="ui-icon-button"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={triggerLabel}
        title={triggerLabel}
        onClick={() => setIsOpen((open) => !open)}
      >
        <span
          aria-hidden="true"
          className="flex h-5 w-5 items-center justify-center rounded-full bg-surface-strong type-annotation font-semibold text-foreground"
        >
          {initial}
        </span>
      </button>

      {isOpen ? (
        <div
          role="menu"
          aria-label="Account"
          className="absolute right-0 top-full z-30 mt-1 min-w-56 overflow-hidden rounded-[8px] border border-border bg-surface py-1 [box-shadow:var(--shadow-elevated)]"
        >
          <div className="px-3 py-2">
            <p className="type-annotation font-medium uppercase tracking-wide text-muted">
              Signed in as
            </p>
            <p className="mt-0.5 truncate text-sm text-foreground" title={email ?? undefined}>
              {email ?? "Unknown account"}
            </p>
          </div>
          <div className="border-t border-border" />
          <form action="/auth/signout" method="post">
            <button
              type="submit"
              role="menuitem"
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-foreground transition-[background-color] duration-100 hover:bg-surface-muted"
            >
              <LogoutIcon className="h-3.5 w-3.5" />
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
