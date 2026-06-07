import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100svh] w-full items-center justify-center bg-surface px-6 py-10 text-foreground"
    >
      <div className="flex w-full max-w-[360px] flex-col items-center gap-6">
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
            className="h-9 w-9 rounded-[9px] bg-surface object-contain"
            priority
          />
          <span className="text-[18px] font-semibold tracking-tight text-foreground">Wallie</span>
        </Link>

        {children}
      </div>
    </main>
  );
}
