import { expect, type Page } from "@playwright/test";
import axe from "axe-core";

type AxeViolation = {
  help: string;
  id: string;
  impact: string | null;
  nodes: number;
  samples?: Array<{ html?: string; target?: string[] }>;
};

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

export async function collectAxeViolations(page: Page): Promise<AxeViolation[]> {
  await page.addScriptTag({ content: axe.source });
  return page.evaluate(async () => {
    const browserAxe = (
      window as unknown as {
        axe: {
          run: (
            root: Document,
            options?: { resultTypes?: string[] },
          ) => Promise<{
            violations: Array<{
              help: string;
              id: string;
              impact: string | null;
              nodes: Array<{ html?: string; target?: string[] }>;
            }>;
          }>;
        };
      }
    ).axe;
    const result = await browserAxe.run(document, { resultTypes: ["violations"] });
    return result.violations.map(({ help, id, impact, nodes }) => ({
      help,
      id,
      impact,
      nodes: nodes.length,
      samples: nodes.slice(0, 3).map((node) => ({
        html: node.html?.slice(0, 160),
        target: node.target,
      })),
    }));
  });
}

export async function expectNoSeriousAxeViolations(
  page: Page,
  options: { disableColorContrast?: boolean } = {},
) {
  const violations = await collectAxeViolations(page);
  const blocking = violations.filter((violation) => {
    if (violation.impact == null || !BLOCKING_IMPACTS.has(violation.impact)) return false;
    if (options.disableColorContrast && violation.id === "color-contrast") return false;
    return true;
  });
  expect(blocking, JSON.stringify(blocking, null, 2)).toEqual([]);
}

export async function expectNamedInteractiveControls(page: Page) {
  const unnamed = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll<HTMLElement>("button, a[href], [role='button'], [role='link']"),
    ];
    return candidates
      .filter((element) => {
        if (element.getClientRects().length === 0) return false;
        if (element.getAttribute("aria-hidden") === "true") return false;
        const label =
          element.getAttribute("aria-label")?.trim() ||
          element.getAttribute("aria-labelledby")?.trim() ||
          element.textContent?.replace(/\s+/g, " ").trim();
        return !label;
      })
      .slice(0, 10)
      .map((element) => ({
        role: element.getAttribute("role"),
        tag: element.tagName,
        testId: element.getAttribute("data-testid"),
      }));
  });
  expect(unnamed).toEqual([]);
}
