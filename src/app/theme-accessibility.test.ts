import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

type Theme = "dark" | "light";
type TokenMap = Record<string, string>;

const semanticPairings = [
  { foreground: "text-primary", backgrounds: ["canvas", "sheet", "raised", "surface-muted"] },
  {
    foreground: "text-secondary",
    backgrounds: ["canvas", "sheet", "raised", "surface-muted"],
  },
  { foreground: "primary", backgrounds: ["canvas", "sheet", "raised", "primary-soft"] },
  { foreground: "primary-foreground", backgrounds: ["primary"] },
  { foreground: "warning", backgrounds: ["sheet", "raised", "warning-soft"] },
  { foreground: "danger", backgrounds: ["sheet", "raised", "danger-soft"] },
  { foreground: "success", backgrounds: ["sheet", "raised", "success-soft"] },
] as const;

const boundaryPairings = [
  { foreground: "border", backgrounds: ["canvas", "sheet", "raised", "surface-muted"] },
  { foreground: "focus-ring", backgrounds: ["canvas", "sheet", "raised", "surface-muted"] },
] as const;

function declarations(block: string): TokenMap {
  return Object.fromEntries(
    [...block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
}

function themeTokens(theme: Theme): TokenMap {
  const lightBlock = stylesheet.match(/:root\s*{([\s\S]*?)\n}/)?.[1];
  const darkBlock = stylesheet.match(/:root\[data-theme="dark"\]\s*{([\s\S]*?)\n}/)?.[1];

  if (!lightBlock || !darkBlock) throw new Error("Theme token blocks are missing");

  return theme === "light"
    ? declarations(lightBlock)
    : { ...declarations(lightBlock), ...declarations(darkBlock) };
}

function resolveToken(name: string, tokens: TokenMap, visited = new Set<string>()): string {
  if (visited.has(name)) throw new Error(`Circular token reference: ${name}`);
  visited.add(name);

  const value = tokens[name];
  if (!value) throw new Error(`Missing token: ${name}`);

  const reference = value.match(/^var\(--([a-z0-9-]+)\)$/)?.[1];
  return reference ? resolveToken(reference, tokens, visited) : value;
}

function luminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error(`Expected a hex color, received ${hex}`);

  const [red, green, blue] = hex
    .slice(1)
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255)
    .map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrastRatio(first: string, second: string): number {
  const firstLuminance = luminance(first);
  const secondLuminance = luminance(second);

  return (
    (Math.max(firstLuminance, secondLuminance) + 0.05) /
    (Math.min(firstLuminance, secondLuminance) + 0.05)
  );
}

describe.each(["light", "dark"] as const)("%s semantic theme", (theme) => {
  const tokens = themeTokens(theme);

  it.each(
    semanticPairings.flatMap(({ foreground, backgrounds }) =>
      backgrounds.map((background) => ({ foreground, background })),
    ),
  )("keeps $foreground on $background at 4.5:1 or better", ({ foreground, background }) => {
    const ratio = contrastRatio(resolveToken(foreground, tokens), resolveToken(background, tokens));

    expect(ratio, `${theme} ${foreground}/${background}`).toBeGreaterThanOrEqual(4.5);
  });

  it.each(
    boundaryPairings.flatMap(({ foreground, backgrounds }) =>
      backgrounds.map((background) => ({ foreground, background })),
    ),
  )("keeps $foreground against $background at 3:1 or better", ({ foreground, background }) => {
    const ratio = contrastRatio(resolveToken(foreground, tokens), resolveToken(background, tokens));

    expect(ratio, `${theme} ${foreground}/${background}`).toBeGreaterThanOrEqual(3);
  });
});

describe("shared interaction accessibility tokens", () => {
  it("uses one two-layer focus-visible indicator, including an inset unclipped variant", () => {
    expect(stylesheet).toContain(":focus-visible {");
    expect(stylesheet).toContain("outline: 2px solid var(--focus-ring);");
    expect(stylesheet).toContain("outline-offset: 2px;");
    expect(stylesheet).toContain("box-shadow: 0 0 0 2px var(--focus-ring-contrast);");
    expect(stylesheet).toContain("outline-offset: -4px;");
    expect(stylesheet).toContain("box-shadow: inset 0 0 0 2px var(--focus-ring-contrast);");
  });

  it("provides pressed feedback and responsive desktop/touch targets", () => {
    expect(stylesheet).toContain(":active:not(:disabled)");
    expect(stylesheet).toContain("transform: translateY(1px);");
    expect(stylesheet).toContain("min-width: 32px;");
    expect(stylesheet).toContain("@media (pointer: coarse), (max-width: 767px)");
    expect(stylesheet).toContain("min-width: 44px;");
    expect(stylesheet).toContain("min-height: 44px;");
    expect(stylesheet).toContain(".ui-touch-target,");
    expect(stylesheet).toContain("grid-template-columns: repeat(6, minmax(44px, 1fr));");
    expect(stylesheet).toContain("grid-template-columns: repeat(3, minmax(44px, 1fr));");
  });
});
