import type { ReactNode } from "react";

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="flex min-h-[100svh] w-full items-center justify-center bg-sheet py-8 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] text-foreground sm:py-10"
    >
      {children}
    </main>
  );
}
