import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  appendDraftStage,
  focusElementIdAfterStageRemoval,
  keepKnownApproverIds,
  moveDraftStage,
  nextUniqueSlug,
  PIPELINE_TEXTAREA_MAX_HEIGHT_PX,
  PIPELINE_TEXTAREA_MIN_HEIGHT_PX,
  pipelineTextareaSize,
  pipelineValidationTargetId,
  pipelineVariableHelpItems,
  previousStageArtifactVariable,
  removeDraftStage,
  slugifyStageName,
  STAGE_SLUG_MAX_LENGTH,
  STAGE_SLUG_PATTERN,
  StageRowEditor,
  updateDraftStage,
  updateDraftStageName,
  validatePipelineDraft,
  type DraftPipelineStage,
} from "@/features/pipeline/editor-primitives";

function stage(overrides: Partial<DraftPipelineStage> = {}): DraftPipelineStage {
  return {
    anyoneCanApprove: false,
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
    expect(
      validatePipelineDraft({
        name: "Default",
        stages: [stage({ anyoneCanApprove: true, approverMemberIds: [] })],
      }),
    ).toEqual({ ok: true });

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

  it("derives unsaved slugs from the name and never changes a saved slug", () => {
    expect(slugifyStageName("Review Gate")).toBe("review-gate");

    const unsaved = [
      stage({ id: null, key: "draft-1", name: "New stage", slug: "new-stage", slugManual: true }),
    ];
    expect(updateDraftStageName(unsaved, 0, "Review Gate")[0]).toMatchObject({
      name: "Review Gate",
      slug: "review-gate",
    });

    const collision = [
      stage({ slug: "review-gate" }),
      stage({ id: null, key: "draft-2", name: "New stage", slug: "new-stage", slugManual: false }),
    ];
    expect(updateDraftStageName(collision, 1, "Review Gate")[1]?.slug).toBe("review-gate-2");

    const saved = [stage({ id: "stage-1", name: "Plan", slug: "plan", slugManual: true })];
    expect(updateDraftStageName(saved, 0, "Planning")[0]).toMatchObject({
      name: "Planning",
      slug: "plan",
    });
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

  it("renders the compact stage row with labelled fields, approval radios, and concrete prior-stage variables", () => {
    const html = renderToStaticMarkup(
      createElement(StageRowEditor, {
        canManage: true,
        compact: true,
        index: 1,
        isFirst: false,
        isLast: false,
        onChange: vi.fn(),
        onChangeName: vi.fn(),
        onMoveDown: vi.fn(),
        onMoveUp: vi.fn(),
        onRemove: vi.fn(),
        onRemoveRequest: vi.fn(),
        priorStages: [{ slug: "plan" }],
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
    expect(html).toContain("Product requirements");
    expect(html).toContain("Prompt template");
    expect(html).toContain("Who can approve?");
    expect(html).toContain("Anyone in the workspace");
    expect(html).toContain("Specific members");
    expect(html).toContain("Approvers");
    expect(html).toContain("{{artifact.previousStages.plan}}");
    expect(html).not.toContain("{{artifact.previousStages.&lt;slug&gt;}}");
    expect(html).not.toContain("{{artifact.previousStages.<slug>}}");
    expect(html).not.toContain(">Slug<");
    expect(html).not.toContain("Order preview");
    expect(html).toContain("Move Product down to position 3 of 2");
    expect(html).toContain("Archive Product from position 2 of 2");
    expect(html).not.toContain("Drag to reorder Product");
    expect(html).toContain("min-h-[160px]");
    expect(html).toContain("max-h-[640px]");
  });

  it("hides the member picker when Anyone in the workspace is selected", () => {
    const html = renderToStaticMarkup(
      createElement(StageRowEditor, {
        canManage: true,
        index: 0,
        isFirst: true,
        isLast: true,
        onChange: vi.fn(),
        onChangeName: vi.fn(),
        onMoveDown: vi.fn(),
        onMoveUp: vi.fn(),
        onRemove: vi.fn(),
        onRemoveRequest: vi.fn(),
        priorStages: [],
        stage: stage({ anyoneCanApprove: true, approverMemberIds: ["member-1"] }),
        totalStages: 1,
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

    expect(html).toContain("Anyone in the workspace");
    expect(html).toContain("Specific members");
    expect(html).not.toContain(">Approvers<");
    expect(html).toContain('value="anyone"');
    expect(html).toContain("checked");
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
    expect(
      pipelineValidationTargetId({
        code: "invalid-stage-slug",
        field: "stage-slug",
        message: "Product slug must use lowercase letters, numbers, and single hyphens.",
        stageIndex: 0,
      }),
    ).toBe("pipeline-stage-0-name");
  });

  it("clamps autosized textarea height between 160px and 640px", () => {
    expect(pipelineTextareaSize(80)).toEqual({
      height: PIPELINE_TEXTAREA_MIN_HEIGHT_PX,
      overflowY: "hidden",
    });
    expect(pipelineTextareaSize(240)).toEqual({ height: 240, overflowY: "hidden" });
    expect(pipelineTextareaSize(PIPELINE_TEXTAREA_MAX_HEIGHT_PX)).toEqual({
      height: PIPELINE_TEXTAREA_MAX_HEIGHT_PX,
      overflowY: "hidden",
    });
    expect(pipelineTextareaSize(PIPELINE_TEXTAREA_MAX_HEIGHT_PX + 80)).toEqual({
      height: PIPELINE_TEXTAREA_MAX_HEIGHT_PX,
      overflowY: "auto",
    });
  });

  it("lists concrete prior-stage artifact variables instead of a slug placeholder", () => {
    expect(previousStageArtifactVariable("plan")).toBe("{{artifact.previousStages.plan}}");
    expect(pipelineVariableHelpItems([{ slug: "plan" }, { slug: "build" }])).toEqual([
      "{{session.title}}",
      "{{session.prompt}}",
      "{{attempt.number}}",
      "{{attempt.feedback}}",
      "{{artifact.previousStages.plan}}",
      "{{artifact.previousStages.build}}",
    ]);
    expect(pipelineVariableHelpItems([])).not.toContain("{{artifact.previousStages.<slug>}}");
  });
});
