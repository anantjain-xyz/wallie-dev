"use client";

import { type ReactNode, useEffect, useEffectEvent, useId, useRef, useState } from "react";

import { cn } from "@/lib/utils";

type DropdownProps = {
  align?: "left" | "right";
  children: ReactNode;
  trigger: ReactNode;
};

export function Dropdown({ align = "left", children, trigger }: DropdownProps) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);

  const handlePointerDown = useEffectEvent((event: PointerEvent) => {
    if (!containerRef.current?.contains(event.target as Node)) {
      setOpen(false);
    }
  });

  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    if (event.key === "Escape") {
      setOpen(false);
    }
  });

  useEffect(() => {
    if (!open) {
      return;
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        className="inline-flex max-w-full rounded-[6px] text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/30 focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        aria-controls={open ? panelId : undefined}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        {trigger}
      </button>

      {open ? (
        <div
          id={panelId}
          role="menu"
          className={cn("ui-dropdown", align === "right" ? "right-0" : "left-0")}
          onClick={() => setOpen(false)}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
}
