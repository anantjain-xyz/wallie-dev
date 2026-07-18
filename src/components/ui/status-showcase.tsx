"use client";

import { useEffect, useState } from "react";

import { Status, STATUS_VALUES } from "@/components/ui/status";
import { cn } from "@/lib/utils";

const themes = ["light", "dark"] as const;
const simulations = [
  { label: "Standard color", value: "standard" },
  { label: "Forced colors preview", value: "forced-colors" },
  { label: "Protanopia", value: "protanopia" },
  { label: "Deuteranopia", value: "deuteranopia" },
  { label: "Tritanopia", value: "tritanopia" },
  { label: "Achromatopsia", value: "achromatopsia" },
] as const;

export type StatusSimulation = (typeof simulations)[number]["value"];

export function isStatusSimulation(value: string | undefined): value is StatusSimulation {
  return simulations.some((simulation) => simulation.value === value);
}

export function StatusShowcase({
  displayMode = "desktop",
  initialSimulation = "standard",
  initialTheme = "light",
  initialZoomed = false,
}: {
  displayMode?: "desktop" | "mobile";
  initialSimulation?: StatusSimulation;
  initialTheme?: (typeof themes)[number];
  initialZoomed?: boolean;
}) {
  const [theme, setTheme] = useState<(typeof themes)[number]>(initialTheme);
  const [simulation, setSimulation] = useState<StatusSimulation>(initialSimulation);
  const [zoomed, setZoomed] = useState(initialZoomed);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      document.documentElement.dataset.theme = "light";
    };
  }, [theme]);

  return (
    <main
      className={cn(
        "min-h-screen bg-canvas px-5 py-10 text-foreground sm:px-8",
        displayMode === "mobile" && "w-[390px] sm:px-5",
      )}
      data-status-display={displayMode}
    >
      <ColorVisionFilters />
      <div className={cn("mx-auto max-w-5xl space-y-8", displayMode === "mobile" && "max-w-none")}>
        <header className="space-y-3">
          <p className="font-mono text-xs uppercase tracking-[0.16em] text-accent">
            Design system lab
          </p>
          <h1 className="text-3xl font-semibold tracking-tight">Product status grammar</h1>
          <p className="max-w-2xl text-sm leading-6 text-muted">
            Exhaustive fixtures for semantic labels, icons, tones, compact density, progress,
            themes, forced colors, and color-vision simulations.
          </p>
        </header>

        <section aria-labelledby="conditions-heading" className="ui-sheet p-5">
          <h2 className="text-base font-semibold" id="conditions-heading">
            Display conditions
          </h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {themes.map((value) => (
              <button
                aria-pressed={theme === value}
                className={theme === value ? "ui-button-primary" : "ui-button"}
                key={value}
                onClick={() => setTheme(value)}
                type="button"
              >
                {value === "light" ? "Light theme" : "Dark theme"}
              </button>
            ))}
            <button
              aria-pressed={zoomed}
              className={zoomed ? "ui-button-primary" : "ui-button"}
              onClick={() => setZoomed((current) => !current)}
              type="button"
            >
              200% zoom preview
            </button>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {simulations.map((option) => (
              <button
                aria-pressed={simulation === option.value}
                className={simulation === option.value ? "ui-button-primary" : "ui-button"}
                key={option.value}
                onClick={() => setSimulation(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>

        <div
          data-status-simulation={simulation === "standard" ? undefined : simulation}
          data-status-zoom={zoomed ? "200" : undefined}
          data-testid="status-fixtures"
          className="space-y-5"
        >
          <StatusFixtureSection compact={false} title="Default" />
          <StatusFixtureSection compact title="Compact" />
          <section className="ui-sheet p-5">
            <h2 className="text-base font-semibold">Determinate progress</h2>
            <div className="mt-4 flex flex-wrap gap-3">
              <Status progress={0} value="queued" />
              <Status progress={45} value="running" />
              <Status progress={100} value="complete" />
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function StatusFixtureSection({ compact, title }: { compact: boolean; title: string }) {
  return (
    <section className="ui-sheet p-5">
      <h2 className="text-base font-semibold">{title}</h2>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {STATUS_VALUES.map((value) => (
          <Status compact={compact} key={value} value={value} />
        ))}
      </div>
    </section>
  );
}

function ColorVisionFilters() {
  return (
    <svg aria-hidden="true" className="absolute h-0 w-0" focusable="false">
      <defs>
        <filter id="status-protanopia">
          <feColorMatrix values="0.567 0.433 0 0 0 0.558 0.442 0 0 0 0 0.242 0.758 0 0 0 0 0 1 0" />
        </filter>
        <filter id="status-deuteranopia">
          <feColorMatrix values="0.625 0.375 0 0 0 0.7 0.3 0 0 0 0 0.3 0.7 0 0 0 0 0 1 0" />
        </filter>
        <filter id="status-tritanopia">
          <feColorMatrix values="0.95 0.05 0 0 0 0 0.433 0.567 0 0 0 0.475 0.525 0 0 0 0 0 1 0" />
        </filter>
      </defs>
    </svg>
  );
}
