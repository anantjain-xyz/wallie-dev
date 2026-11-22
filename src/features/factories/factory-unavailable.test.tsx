import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { FactoryUnavailable } from "./factory-unavailable";

describe("FactoryUnavailable", () => {
  it("links to the workspace-scoped aggregate sessions view without a detail id", () => {
    const html = renderToStaticMarkup(<FactoryUnavailable title="Agents" workspaceSlug="acme" />);

    expect(html).toContain("Factory unavailable");
    expect(html).toContain("Return to sessions to choose a factory you can access.");
    expect(html).toContain("View accessible sessions");
    expect(html).toContain('href="/w/acme/sessions?factory=all"');
    expect(html).not.toContain("agentId=");
    expect(html).not.toContain("scorerId=");
    expect(html).not.toContain("sessionId=");
  });
});
