import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  appendDraftStage,
  keepKnownApproverIds,
  moveDraftStage,
  removeDraftStage,
  StageRowEditor,
  updateDraftStage,
  validatePipelineDraft,
  type DraftPipelineStage,
} from "@/features/pipeline/editor-primitives";

function stage(overrides: Partial<DraftPipelineStage> = {}): DraftPipelineStage {
  return {
    approverMemberIds: [],
    description: "Product requirements",
    id: "stage-product",
    name: "Product",
    promptTemplateMd: "Write a spec.",
    slug: "product",
    ...overrides,
  };
}

describe("pipeline editor primitives", () => {
  it("validates required pipeline and stage fields", () => {
    expect(validatePipelineDraft({ name: "", stages: [stage()] })).toMatchObject({
      code: "missing-pipeline-name",
      ok: false,
    });
    expect(validatePipelineDraft({ name: "Default", stages: [] })).toMatchObject({
      code: "empty-stage-list",
      ok: false,
    });
    expect(
      validatePipelineDraft({ name: "Default", stages: [stage({ name: " " })] }),
    ).toMatchObject({
      code: "missing-stage-name",
      ok: false,
    });
  });

  it("validates kebab-case slugs and duplicate stage slugs", () => {
    expect(
      validatePipelineDraft({ name: "Default", stages: [stage({ slug: "Bad Slug" })] }),
    ).toMatchObject({
      code: "invalid-stage-slug",
      ok: false,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage(), stage({ id: "stage-copy", name: "Product copy" })],
      }),
    ).toMatchObject({
      code: "duplicate-stage-slug",
      ok: false,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage(), stage({ id: "stage-design", name: "Design", slug: "design" })],
      }),
    ).toEqual({ ok: true });
  });

  it("updates, appends, moves, and removes draft stages immutably", () => {
    const initial = [stage(), stage({ id: "stage-design", name: "Design", slug: "design" })];

    expect(updateDraftStage(initial, 0, { name: "Product plan" })[0]?.name).toBe("Product plan");
    expect(initial[0]?.name).toBe("Product");

    expect(appendDraftStage(initial).map((item) => item.slug)).toEqual([
      "product",
      "design",
      "new-stage",
    ]);
    expect(moveDraftStage(initial, 0, 1).map((item) => item.slug)).toEqual(["design", "product"]);
    expect(removeDraftStage(initial, 1).map((item) => item.slug)).toEqual(["product"]);
  });

  it("drops approver ids that are no longer in the workspace member picker", () => {
    const stages = [
      stage({ approverMemberIds: ["member-1", "removed-member", "member-2"] }),
      stage({ id: "stage-design", name: "Design", slug: "design" }),
    ];

    expect(
      keepKnownApproverIds(stages, [
        { email: "one@example.com", fullName: "One", id: "member-1", role: "owner" },
        { email: "two@example.com", fullName: "Two", id: "member-2", role: "member" },
      ]),
    ).toEqual([
      stage({ approverMemberIds: ["member-1", "member-2"] }),
      stage({ id: "stage-design", name: "Design", slug: "design" }),
    ]);
  });

  it("renders the compact stage row with all editable fields and controls", () => {
    const html = renderToStaticMarkup(
      createElement(StageRowEditor, {
        canManage: true,
        compact: true,
        index: 0,
        isFirst: true,
        isLast: false,
        onChange: vi.fn(),
        onMoveDown: vi.fn(),
        onMoveUp: vi.fn(),
        onRemove: vi.fn(),
        stage: stage(),
        workspaceMembers: [
          {
            email: "owner@example.com",
            fullName: "Owner",
            id: "member-1",
            role: "owner",
          },
        ],
      }),
    );

    expect(html).toContain("Product");
    expect(html).toContain("product");
    expect(html).toContain("Product requirements");
    expect(html).toContain("Prompt template");
    expect(html).toContain("Move stage down");
    expect(html).toContain("Remove stage");
  });
});
