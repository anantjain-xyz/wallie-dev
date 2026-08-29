import { describe, expect, it } from "vitest";

import {
  AGENT_CONFIG_VISIBLE_FIELDS,
  AGENT_PROVIDER_SELECT_OPTIONS,
} from "@/components/shared/agent-provider-options";

describe("AGENT_PROVIDER_SELECT_OPTIONS", () => {
  it("exposes Codex, Claude Code, and Cursor", () => {
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.value)).toEqual([
      "codex",
      "claude-code",
      "cursor",
    ]);
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.label)).toEqual([
      "Codex",
      "Claude Code",
      "Cursor",
    ]);
    expect(AGENT_PROVIDER_SELECT_OPTIONS.map((option) => option.label)).not.toContain(
      "Not configured",
    );
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
