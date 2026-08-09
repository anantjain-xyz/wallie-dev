import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionsZeroState } from "@/features/sessions/components/sessions-zero-state";

function renderZeroState(variant: "archived" | "first-run") {
  return renderToStaticMarkup(
    createElement(SessionsZeroState, {
      newSessionHref: "/w/acme?create=1",
      onboarding: null,
      variant,
      workspaceSlug: "acme",
    }),
  );
}

describe("SessionsZeroState", () => {
  it("uses first-time copy when the workspace has never had a session", () => {
    const html = renderZeroState("first-run");

    expect(html).toContain("No sessions yet");
    expect(html).toContain("Turn a Linear issue into a session");
    expect(html).not.toContain("archived");
  });

  it("uses returning-workspace copy when every session is archived", () => {
    const html = renderZeroState("archived");

    expect(html).toContain("No active sessions");
    expect(html).toContain("All sessions have been archived");
    expect(html).not.toContain("No sessions yet");
  });
});
