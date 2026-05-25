import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  LinearRoutingEditor,
  splitStatuses,
  validateLinearRoutingDraftStages,
} from "@/features/settings/linear-routing-editor";
import { DEFAULT_LINEAR_ROUTING_CONFIG } from "@/lib/linear-routing/contracts";

const stages = [
  {
    approverMemberIds: [],
    description: "Engineering",
    id: "stage-engineering",
    name: "Engineering",
    pipelineId: "pipeline-1",
    position: 1,
    promptTemplateMd: "",
    slug: "engineering",
  },
  {
    approverMemberIds: [],
    description: "Land",
    id: "stage-land",
    name: "Land",
    pipelineId: "pipeline-1",
    position: 2,
    promptTemplateMd: "",
    slug: "land",
  },
];

describe("Linear routing editor", () => {
  it("splits status mappings from comma and newline separated input", () => {
    expect(splitStatuses("Todo, In Progress\nIn Review")).toEqual([
      "Todo",
      "In Progress",
      "In Review",
    ]);
  });

  it("requires routing stage slugs to exist in the current default pipeline", () => {
    expect(
      validateLinearRoutingDraftStages(
        {
          landStageSlug: "ship",
          reworkStageSlug: "engineering",
        },
        stages.map((stage) => stage.slug),
      ),
    ).toBe("Land stage must match a current default pipeline stage.");
    expect(
      validateLinearRoutingDraftStages(
        {
          landStageSlug: "land",
          reworkStageSlug: "engineering",
        },
        stages.map((stage) => stage.slug),
      ),
    ).toBeNull();
  });

  it("smoke-renders the Settings routing editor after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(LinearRoutingEditor, {
        canManage: true,
        routing: DEFAULT_LINEAR_ROUTING_CONFIG,
        stages,
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(html).toContain("Rework stage");
    expect(html).toContain("Land stage");
    expect(html).toContain("Status mappings");
    expect(html).toContain("Stage routing");
    expect(html).toContain("Linear status names");
    expect(html).toContain("Wallie action");
    expect(html).toContain("→");
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-haspopup="listbox"');
    expect(html).not.toContain("<select");
    expect(html).toContain("Restart at engineering stage");
    expect(html).toContain("Route to land stage");
    expect(html).toContain("Save routing");
    expect(html).toContain("engineering");
    expect(html).toContain("land");
  });

  it("preserves unmatched saved stage slugs in the selector display", () => {
    const html = renderToStaticMarkup(
      createElement(LinearRoutingEditor, {
        canManage: true,
        routing: {
          ...DEFAULT_LINEAR_ROUTING_CONFIG,
          reworkStageSlug: "renamed-stage",
        },
        stages,
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(html.match(/renamed-stage/g)).toHaveLength(2);
  });
});
