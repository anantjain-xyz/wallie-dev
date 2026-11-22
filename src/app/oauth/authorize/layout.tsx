import type { ReactNode } from "react";

export default function AuthorizeLayout({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1}>
      {children}
    </main>
  );
}
