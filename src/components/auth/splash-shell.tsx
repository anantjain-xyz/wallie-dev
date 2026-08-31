import type { ReactNode } from "react";

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100svh] w-full items-center justify-center bg-sheet px-4 py-8 text-foreground sm:px-6 sm:py-10"
    >
      {children}
    </main>
  );
}
