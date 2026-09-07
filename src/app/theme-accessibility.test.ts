import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(join(process.cwd(), "src/app/globals.css"), "utf8");

type Theme = "dark" | "light";
type TokenMap = Record<string, string>;

const semanticPairings = [
  {
    foreground: "text-primary",
    backgrounds: ["surface-canvas", "surface-sheet", "surface-overlay", "control-muted"],
  },
  {
    foreground: "text-secondary",
    backgrounds: ["surface-canvas", "surface-sheet", "surface-overlay", "control-muted"],
  },
  {
    foreground: "primary",
    backgrounds: ["surface-canvas", "surface-sheet", "surface-overlay", "primary-soft"],
  },
  { foreground: "primary-foreground", backgrounds: ["primary"] },
  { foreground: "warning", backgrounds: ["surface-sheet", "surface-overlay", "warning-soft"] },
  { foreground: "danger", backgrounds: ["surface-sheet", "surface-overlay", "danger-soft"] },
  { foreground: "success", backgrounds: ["surface-sheet", "surface-overlay", "success-soft"] },
] as const;

const boundaryPairings = [
  {
    foreground: "border-control",
    backgrounds: ["surface-sheet", "surface-overlay", "control-hover"],
  },
  {
    foreground: "border-control-hover",
    backgrounds: ["surface-sheet", "surface-overlay", "control-hover", "control-muted"],
  },
  {
    foreground: "focus-ring",
    backgrounds: ["surface-canvas", "surface-sheet", "surface-overlay", "control-muted"],
  },
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

function focusVisibleBlocks(): { selector: string; body: string }[] {
  return [...stylesheet.matchAll(/:where\(([\s\S]*?)\):focus-visible\s*{([\s\S]*?)\}/g)].map(
    (match) => ({ selector: match[1], body: match[2] }),
  );
}

function focusVisibleRules(selector: string): string[] {
  return focusVisibleBlocks()
    .filter((block) => block.selector.includes(selector))
    .map((block) => block.body);
}

function chromeFocusSelector(): string {
  const match = stylesheet.match(
    /Unlayered so one focus contract[\s\S]*?:where\(([\s\S]*?)\):focus-visible\s*\{/u,
  );

  if (!match?.[1]) throw new Error("Chrome focus-visible rule missing");

  return match[1];
}

function textEntryFocusRule(): { selector: string; body: string } {
  const match = stylesheet.match(
    /Unlayered text-entry:[\s\S]*?:where\(([\s\S]*?)\):focus-visible\s*\{([\s\S]*?)\}/u,
  );

  if (!match?.[1] || match[2] === undefined) {
    throw new Error("text-entry focus-visible rule missing");
  }

  return { selector: match[1], body: match[2] };
}

describe.each(["light", "dark"] as const)("%s semantic theme", (theme) => {
  const tokens = themeTokens(theme);

  it.each(["surface-canvas", "surface-sheet", "surface-overlay"])(
    "keeps decorative borders quiet on %s, below control contrast",
    (background) => {
      const surface = resolveToken(background, tokens);
      const resting = contrastRatio(resolveToken("border", tokens), surface);
      const emphasized = contrastRatio(resolveToken("border-strong", tokens), surface);
      const control = contrastRatio(resolveToken("border-control", tokens), surface);

      expect(resting).toBeLessThan(1.6);
      expect(emphasized).toBeGreaterThan(resting);
      expect(emphasized).toBeLessThan(control);
    },
  );

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

  it("bounds off-screen rendering and reveals interactive contained content", () => {
    expect(stylesheet).toMatch(/\.settings-contained-section\s*\{[^}]*content-visibility: auto;/u);
    expect(stylesheet).toMatch(/\.session-list-row\s*\{[^}]*content-visibility: auto;/u);
    expect(stylesheet).toMatch(/\.run-history-group\s*\{[^}]*content-visibility: auto;/u);
    expect(stylesheet).toContain("contain-intrinsic-size: auto 0 auto 680px;");
    expect(stylesheet).toContain("contain-intrinsic-size: auto 0 auto 116px;");
    expect(stylesheet).toMatch(/:focus-within,[\s\S]*content-visibility: visible;/u);
    expect(stylesheet).toMatch(
      /\.content-visibility-interacting\s*\{[^}]*content-visibility: visible;/u,
    );
  });

  it.each([".ui-menu-item", ".ui-select-item"])(
    "keeps the primary outline and inset contrast layer on %s",
    (selector) => {
      const rules = focusVisibleRules(selector);

      expect(rules.some((rule) => rule.includes("outline: 2px solid var(--focus-ring);"))).toBe(
        true,
      );
      expect(
        rules.some((rule) =>
          rule.includes("box-shadow: inset 0 0 0 2px var(--focus-ring-contrast);"),
        ),
      ).toBe(true);
    },
  );

  it.each([".ui-menu-item", ".ui-select-item"])(
    "uses a pointer cursor on enabled %s overlay items",
    (selector) => {
      const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = stylesheet.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`, "u"));

      if (!match?.[1]) throw new Error(`Missing ${selector} rule`);

      expect(match[1]).toContain("cursor-pointer");
      expect(match[1]).not.toContain("cursor-default");
    },
  );

  it("keeps the two-layer ring on chrome controls, not text entry", () => {
    const chromeSelector = chromeFocusSelector();

    expect(chromeSelector).toMatch(/\bbutton\b/);
    expect(chromeSelector).toMatch(/\bselect\b/);
    expect(chromeSelector).toContain('[role="combobox"]');
    expect(chromeSelector).toContain('input[type="checkbox"]');
    expect(chromeSelector).toContain('input[type="radio"]');
    expect(chromeSelector).toContain('input[type="file"]');
    expect(chromeSelector).not.toMatch(/(?:^|,)\s*input\s*,/u);
    expect(chromeSelector).not.toMatch(/(?:^|,)\s*textarea\s*(?:,|$)/u);
  });

  it("uses an in-control text-entry focus indicator without an outer halo", () => {
    const textEntry = textEntryFocusRule();

    expect(textEntry.selector).toContain("textarea");
    expect(textEntry.selector).toContain('[role="textbox"]');
    expect(textEntry.selector).toContain('input:not([type="button"])');
    expect(textEntry.selector).toContain('[type="checkbox"]');
    expect(textEntry.selector).toContain('[type="file"]');
    expect(textEntry.body).toContain("outline: none;");
    expect(textEntry.body).toContain("outline-offset: 0;");
    expect(textEntry.body).toContain("border-color: var(--accent);");
    expect(textEntry.body).toContain("box-shadow: inset 0 0 0 1px var(--accent);");
    expect(textEntry.body).not.toContain("outline: 2px solid var(--focus-ring);");
    expect(textEntry.body).not.toContain("box-shadow: 0 0 0 2px var(--focus-ring-contrast);");
    expect(stylesheet).toContain(".ui-input:focus-visible,");
    expect(stylesheet).toContain(".ui-textarea:focus-visible {");
    expect(stylesheet).toContain(".sidebar-input:focus-visible {");
    expect(stylesheet).toMatch(
      /\.ui-input:focus-visible,[\s\S]*?\.ui-textarea:focus-visible\s*\{[\s\S]*?border-color: var\(--accent\);/u,
    );
  });

  it("restores a CanvasText focus outline on text fields in forced-colors", () => {
    expect(stylesheet).toMatch(
      /@media \(forced-colors: active\)\s*\{[\s\S]*textarea[\s\S]*outline: 2px solid CanvasText;[\s\S]*outline-offset: 2px;/u,
    );
  });

  it("provides pressed feedback and responsive desktop/touch targets", () => {
    expect(stylesheet).toContain(":active:not(:disabled)");
    expect(stylesheet).toContain("transform: translateY(1px);");
    expect(stylesheet).toContain("min-width: 32px;");
    expect(stylesheet).toContain("@media (pointer: coarse), (max-width: 767px)");
    expect(stylesheet).toContain("min-width: 44px;");
    expect(stylesheet).toContain("min-height: 44px;");
    expect(stylesheet).toContain(".ui-touch-target,");
    expect(stylesheet).toContain("grid-template-columns: repeat(6, minmax(2.75rem, 1fr));");
    expect(stylesheet).toContain("container-name: email-code-form;");
    expect(stylesheet).toContain("@container email-code-form (max-width: 19rem)");
    expect(stylesheet).toContain("grid-template-columns: repeat(3, minmax(2.75rem, 1fr));");
    expect(stylesheet).not.toContain("minmax(44px, 1fr)");
    expect(stylesheet).not.toContain("@container email-code-form (max-width: 283px)");
  });

  it("keeps overlays inside inline safe areas and focusable scroll regions visible", () => {
    expect(stylesheet).toContain("--overlay-gutter-inline: max(");
    expect(stylesheet).toContain("env(safe-area-inset-left)");
    expect(stylesheet).toContain("env(safe-area-inset-right)");
    expect(stylesheet).toContain('[role="region"][tabindex]');
  });
});

describe("Precision Console surface contract", () => {
  it("defines only canvas, primary sheet, and overlay as hierarchy surfaces", () => {
    expect(stylesheet).toContain("--surface-canvas:");
    expect(stylesheet).toContain("--surface-sheet:");
    expect(stylesheet).toContain("--surface-overlay:");
    expect(stylesheet).not.toMatch(/--(?:canvas|sheet|raised|surface-strong|surface-muted):/u);
  });

  it("reserves ten-pixel radii and elevation for overlays", () => {
    expect(stylesheet).toContain("--content-radius: 6px;");
    expect(stylesheet).toContain("--overlay-radius: 10px;");
    expect(stylesheet).toContain("box-shadow: var(--shadow-elevated);");
    expect(stylesheet).not.toContain("--shadow-ambient:");
    expect(stylesheet).not.toContain("--shadow-control:");
  });

  it("reserves fully rounded shared treatment for status", () => {
    expect(stylesheet).toMatch(/\.ui-status\s*\{[\s\S]*?rounded-full/u);
    expect(stylesheet).not.toMatch(/\.ui-(?:tab|filter-chip|icon-button)\s*\{[^}]*rounded-full/u);
  });
});
