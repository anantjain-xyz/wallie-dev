import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100svh] w-full items-center justify-center bg-sheet px-4 py-8 text-foreground sm:px-6 sm:py-10"
    >
      <div className="flex w-full max-w-[400px] flex-col items-center gap-6">
        <Link
          href="/"
          aria-label="Wallie home"
          className="flex items-center gap-2.5 focus-visible:outline-none"
        >
          <Image
            src="/wallie-logo-minimal.png"
            alt=""
            width={36}
            height={36}
            className="h-9 w-9 rounded-[6px] object-contain dark:invert"
            priority
          />
          <span className="text-[18px] font-semibold tracking-tight text-foreground">Wallie</span>
        </Link>

        {children}
      </div>
    </main>
  );
}
