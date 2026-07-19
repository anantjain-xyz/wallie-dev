import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  appendDraftStage,
  focusElementIdAfterStageRemoval,
  keepKnownApproverIds,
  moveDraftStage,
  nextUniqueSlug,
  reorderDraftStage,
  removeDraftStage,
  slugifyStageName,
  STAGE_SLUG_MAX_LENGTH,
  STAGE_SLUG_PATTERN,
  StageRowEditor,
  updateDraftStage,
  updateDraftStageName,
  updateDraftStageSlug,
  validatePipelineDraft,
  type DraftPipelineStage,
} from "@/features/pipeline/editor-primitives";

function stage(overrides: Partial<DraftPipelineStage> = {}): DraftPipelineStage {
  return {
    approverMemberIds: ["member-1"],
    description: "Product requirements",
    id: "stage-product",
    key: "stage-product",
    name: "Product",
    promptTemplateMd: "Write a spec.",
    slug: "product",
    slugManual: true,
    ...overrides,
  };
}

describe("pipeline editor primitives", () => {
  it("picks post-removal focus ids for surviving rows and Add stage", () => {
    expect(focusElementIdAfterStageRemoval(1, 0)).toBe("pipeline-add-stage");
    expect(focusElementIdAfterStageRemoval(3, 0)).toBe("pipeline-stage-0-name");
    expect(focusElementIdAfterStageRemoval(3, 1)).toBe("pipeline-stage-1-name");
    expect(focusElementIdAfterStageRemoval(3, 2)).toBe("pipeline-stage-1-name");
  });

  it("validates required pipeline and stage fields including prompt and approver", () => {
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
      stageIndex: 0,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage({ promptTemplateMd: "   " })],
      }),
    ).toMatchObject({
      code: "missing-stage-prompt",
      field: "stage-prompt",
      ok: false,
      stageIndex: 0,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage({ approverMemberIds: [] })],
      }),
    ).toMatchObject({
      code: "missing-stage-approver",
      field: "stage-approvers",
      ok: false,
      stageIndex: 0,
    });

    const multiStage = validatePipelineDraft({
      name: "Default",
      stages: [
        stage(),
        stage({
          approverMemberIds: [],
          id: "stage-2",
          name: "",
          promptTemplateMd: "",
          slug: "Bad Slug",
          slugManual: true,
        }),
      ],
    });
    expect(multiStage).toMatchObject({
      code: "missing-stage-name",
      field: "stage-name",
      ok: false,
      stageIndex: 1,
    });
    if (!multiStage.ok) {
      expect(multiStage.issues.map((issue) => issue.field)).toEqual([
        "stage-name",
        "stage-slug",
        "stage-prompt",
        "stage-approvers",
      ]);
      expect(multiStage.issues.every((issue) => issue.stageIndex === 1)).toBe(true);
    }
  });

  it("validates kebab-case slugs, duplicate stage slugs, and duplicate stage ids", () => {
    expect(
      validatePipelineDraft({ name: "Default", stages: [stage({ slug: "Bad Slug" })] }),
    ).toMatchObject({
      code: "invalid-stage-slug",
      ok: false,
      stageIndex: 0,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage(), stage({ id: "stage-copy", name: "Product copy", slug: "product" })],
      }),
    ).toMatchObject({
      code: "duplicate-stage-slug",
      ok: false,
      stageIndex: 1,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [
          stage(),
          stage({ id: "stage-product", name: "Clone", slug: "clone", promptTemplateMd: "x" }),
        ],
      }),
    ).toMatchObject({
      code: "invalid-stage-ordering",
      ok: false,
      stageIndex: 1,
    });
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [
          stage(),
          stage({
            id: "stage-design",
            name: "Design",
            promptTemplateMd: "Design it.",
            slug: "design",
          }),
        ],
      }),
    ).toEqual({ ok: true });
  });

  it("follows name into slug until the slug is edited manually", () => {
    expect(slugifyStageName("Review Gate")).toBe("review-gate");

    const initial = [
      stage({ id: null, key: "draft-1", name: "New stage", slug: "new-stage", slugManual: false }),
    ];
    const renamed = updateDraftStageName(initial, 0, "Review Gate");
    expect(renamed[0]).toMatchObject({
      name: "Review Gate",
      slug: "review-gate",
      slugManual: false,
    });

    const lockedSlug = updateDraftStageSlug(renamed, 0, "custom-slug");
    expect(lockedSlug[0]).toMatchObject({ slug: "custom-slug", slugManual: true });
    expect(updateDraftStageName(lockedSlug, 0, "Something Else")[0]).toMatchObject({
      name: "Something Else",
      slug: "custom-slug",
      slugManual: true,
    });

    const saved = [stage({ id: "stage-1", name: "Plan", slug: "plan", slugManual: true })];
    expect(updateDraftStageName(saved, 0, "Planning")[0]).toMatchObject({
      name: "Planning",
      slug: "plan",
    });
    expect(updateDraftStageSlug(saved, 0, "planning")).toBe(saved);
  });

  it("updates, appends, moves, reorders, and removes draft stages immutably", () => {
    const initial = [
      stage(),
      stage({
        id: "stage-design",
        name: "Design",
        promptTemplateMd: "Design it.",
        slug: "design",
      }),
    ];

    expect(updateDraftStage(initial, 0, { name: "Product plan" })[0]?.name).toBe("Product plan");
    expect(initial[0]?.name).toBe("Product");

    expect(appendDraftStage(initial).map((item) => item.slug)).toEqual([
      "product",
      "design",
      "new-stage",
    ]);
    expect(moveDraftStage(initial, 0, 1).map((item) => item.slug)).toEqual(["design", "product"]);
    expect(reorderDraftStage(initial, 1, 0).map((item) => item.slug)).toEqual([
      "design",
      "product",
    ]);
    expect(removeDraftStage(initial, 1).map((item) => item.slug)).toEqual(["product"]);
  });

  it("drops approver ids that are no longer in the workspace member picker", () => {
    const stages = [
      stage({ approverMemberIds: ["member-1", "removed-member", "member-2"] }),
      stage({
        id: "stage-design",
        name: "Design",
        promptTemplateMd: "Design it.",
        slug: "design",
      }),
    ];

    expect(
      keepKnownApproverIds(stages, [
        { email: "one@example.com", fullName: "One", id: "member-1", role: "owner" },
        { email: "two@example.com", fullName: "Two", id: "member-2", role: "member" },
      ]),
    ).toEqual([
      stage({ approverMemberIds: ["member-1", "member-2"] }),
      stage({
        id: "stage-design",
        name: "Design",
        promptTemplateMd: "Design it.",
        slug: "design",
      }),
    ]);
  });

  it("renders the compact stage row with labelled fields and named reorder controls", () => {
    const html = renderToStaticMarkup(
      createElement(StageRowEditor, {
        canManage: true,
        compact: true,
        dragIndex: null,
        index: 0,
        isFirst: true,
        isLast: false,
        onChange: vi.fn(),
        onChangeName: vi.fn(),
        onChangeSlug: vi.fn(),
        onDragEnd: vi.fn(),
        onDragOver: vi.fn(),
        onDragStart: vi.fn(),
        onDrop: vi.fn(),
        onMoveDown: vi.fn(),
        onMoveUp: vi.fn(),
        onRemove: vi.fn(),
        onRemoveRequest: vi.fn(),
        stage: stage(),
        totalStages: 2,
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
    expect(html).toContain("Move Product down to position 2 of 2");
    expect(html).toContain("Remove Product from position 1 of 2");
    expect(html).toContain("Drag to reorder Product");
    expect(html).toContain("Locked after save");
    // Saved slugs stay focusable (readOnly) so keyboard users can copy them.
    expect(html).toMatch(/id="pipeline-stage-0-slug"[^>]*readOnly/);
    expect(html).not.toMatch(/id="pipeline-stage-0-slug"[^>]*disabled/);
  });

  it("bounds auto-generated slugs to the API max length and validates oversize slugs", () => {
    const longName = `Review ${"Gate ".repeat(20)}Final`;
    const slug = slugifyStageName(longName);
    expect(slug.length).toBeLessThanOrEqual(STAGE_SLUG_MAX_LENGTH);
    expect(STAGE_SLUG_PATTERN.test(slug)).toBe(true);

    const withCollision = [
      stage({
        id: null,
        key: "draft-long",
        name: longName,
        slug,
        slugManual: false,
      }),
    ];
    const unique = nextUniqueSlug(slug, withCollision);
    expect(unique.length).toBeLessThanOrEqual(STAGE_SLUG_MAX_LENGTH);
    expect(unique).not.toBe(slug);

    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage({ slug: `${"a".repeat(STAGE_SLUG_MAX_LENGTH)}x` })],
      }),
    ).toMatchObject({
      code: "invalid-stage-slug",
      ok: false,
      stageIndex: 0,
    });
  });
});
