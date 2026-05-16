import type { ReactNode } from "react";

type ValueProp = {
  number: string;
  title: string;
  body: string;
};

const valueProps: ValueProp[] = [
  {
    number: "01",
    title: "Sessions, not tickets.",
    body: "A single thread from idea to shipped change.",
  },
  {
    number: "02",
    title: "Phases that hand themselves off.",
    body: "Product, design, engineering, review, land.",
  },
  {
    number: "03",
    title: "Every artifact, versioned.",
    body: "Each spec, design, and diff is reviewable.",
  },
];

export function SplashShell({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      className="flex min-h-[100svh] w-full flex-col bg-[#f6f1e7] text-[#1a1714]"
    >
      <div className="mx-auto flex w-full max-w-[1120px] flex-1 flex-col px-6 py-10 sm:px-10 lg:py-12">
        <header>
          <h1
            className="text-[40px] leading-none tracking-[-0.015em] text-[#1a1714] sm:text-[44px]"
            style={{ fontFamily: "var(--font-newsreader)" }}
          >
            Wallie
          </h1>
        </header>

        <div className="mt-5 h-px w-full bg-[#d9cfbf]" />

        <div className="grid flex-1 grid-cols-1 items-center gap-12 py-10 lg:grid-cols-[1fr_minmax(320px,400px)] lg:gap-16 lg:py-0">
          <section aria-label="What Wallie does" className="max-w-[480px]">
            <ol className="space-y-7">
              {valueProps.map((prop) => (
                <li key={prop.number} className="grid grid-cols-[44px_1fr] gap-4">
                  <span aria-hidden="true" className="text-[22px] leading-none text-[#bdb19e]">
                    {prop.number}
                  </span>
                  <div>
                    <h2 className="text-[18px] font-semibold leading-[1.3] tracking-[-0.005em] text-[#1a1714]">
                      {prop.title}
                    </h2>
                    <p className="mt-1 text-[13.5px] leading-[1.55] text-[#6b6358]">{prop.body}</p>
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
