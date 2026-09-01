import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AGENT_CONFIG_VISIBLE_FIELDS,
  AGENT_PROVIDER_SELECT_OPTIONS,
  AgentProviderLogo,
} from "@/components/shared/agent-provider-options";

describe("AGENT_PROVIDER_SELECT_OPTIONS", () => {
  it("exposes all supported providers", () => {
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.value)).toEqual([
      "codex",
      "claude-code",
      "cursor",
      "opencode",
    ]);
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.label)).toEqual([
      "Codex",
      "Claude Code",
      "Cursor",
      "OpenCode",
    ]);
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.label)).not.toContain(
      "Not configured",
    );
  });

  it("uses Cursor's official hexagonal mark", () => {
    const html = renderToStaticMarkup(AgentProviderLogo({ provider: "cursor" }));
    expect(html).toContain('viewBox="0 0 499 545"');
    expect(html).toContain("466.383 137.073");
    expect(html).not.toContain("M5 3v18");
  });

  it("uses OpenCode's official rectangular O mark", () => {
    const html = renderToStaticMarkup(AgentProviderLogo({ provider: "opencode" }));
    expect(html).toContain('viewBox="0 0 240 300"');
    expect(html).toContain("M180 60H60V240H180V60ZM240 300H0V0H240V300Z");
    expect(html).not.toContain("M5 4.5h14v15H5z");
  });
});

describe("AGENT_CONFIG_VISIBLE_FIELDS", () => {
  it("uses the shortened labels and help copy", () => {
    expect(AGENT_CONFIG_VISIBLE_FIELDS).toEqual({
      agent_effort: {
        description: "Reasoning effort passed to the selected provider.",
        label: "Effort",
      },
      agent_model: {
        description: "Model identifier passed to the selected provider.",
        label: "Model",
      },
      agent_provider: {
        description: "Choose the coding agent Wallie uses for runs.",
        label: "Provider",
      },
    });
  });
});
