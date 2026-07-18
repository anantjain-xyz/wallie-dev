import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChevronDownIcon } from "@/components/shared/icons/chevron-down-icon";
import { GitHubIcon } from "@/components/shared/icons/github-icon";
import { PriorityBarIcon } from "@/components/shared/icons/priority-bar-icon";
import { XIcon } from "@/components/shared/icons/x-icon";

const decorativeIcons = {
  "composed icon": <PriorityBarIcon priority="urgent" />,
  "fill icon": <GitHubIcon />,
  "single-letter icon": <XIcon />,
  "stroke icon": <ChevronDownIcon />,
};

describe("shared icons", () => {
  it.each(Object.entries(decorativeIcons))("keeps %s decorative by default", (_, icon) => {
    const markup = renderToStaticMarkup(icon);

    expect(markup).toContain('aria-hidden="true"');
    expect(markup).toContain('class="h-4 w-4 shrink-0"');
  });

  it("preserves caller-provided SVG attributes and class names", () => {
    const markup = renderToStaticMarkup(
      <ChevronDownIcon aria-label="Expand" className="h-6 text-accent" data-testid="chevron" />,
    );

    expect(markup).toContain('aria-label="Expand"');
    expect(markup).toContain('class="w-4 shrink-0 h-6 text-accent"');
    expect(markup).toContain('data-testid="chevron"');
    expect(markup).toContain('stroke="currentColor"');
  });
});
