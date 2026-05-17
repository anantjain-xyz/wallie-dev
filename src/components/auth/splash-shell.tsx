import type { ReactNode } from "react";

type ValueProp = {
  number: string;
  title: string;
  body: string;
};

const valueProps: ValueProp[] = [
  {
    number: "01",
    title: "Drives the work all the way to production.",
    body: "Spec, design, code, review, ship, and verify — one continuous flow.",
  },
  {
    number: "02",
    title: "Adapts to how your team builds.",
    body: "Reorder phases, customize prompts, and set the right approver for each stage.",
  },
  {
    number: "03",
    title: "Each phase starts where the last one ended.",
    body: "Approved artifacts and reviewer feedback flow into the next agent's context automatically.",
  },
];

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100svh] w-full flex-col bg-surface text-foreground"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-6 py-10 sm:px-10 lg:py-12">
        <header>
          <h1 className="text-[32px] font-semibold leading-none tracking-tight text-foreground sm:text-[36px]">
            Wallie
          </h1>
        </header>

        <div className="mt-5 h-px w-full bg-border" />

        <div className="grid flex-1 grid-cols-1 items-center gap-12 py-10 lg:grid-cols-[1fr_minmax(320px,400px)] lg:gap-16 lg:py-0">
          <section aria-label="What Wallie does" className="max-w-[480px]">
            <ol className="space-y-7">
              {valueProps.map((prop) => (
                <li key={prop.number} className="grid grid-cols-[44px_1fr] gap-4">
                  <span aria-hidden="true" className="text-[22px] leading-none text-muted/60">
                    {prop.number}
                  </span>
                  <div>
                    <h2 className="text-[18px] font-semibold leading-[1.3] tracking-[-0.005em] text-foreground">
                      {prop.title}
                    </h2>
                    <p className="mt-1 text-[13.5px] leading-[1.55] text-muted">{prop.body}</p>
                  </div>
                </li>
              ))}
            </ol>
          </section>

          <div className="flex justify-start lg:justify-end">{children}</div>
        </div>
      </div>
    </main>
  );
}
