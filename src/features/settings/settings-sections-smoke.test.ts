import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LinearKeySection } from "@/features/settings/linear-key-section";
import { PipelineEditor } from "@/features/settings/pipeline-editor";

const workspaceId = "00000000-0000-4000-8000-000000000001";

describe("Settings integration sections", () => {
  it("smoke-renders the Settings pipeline editor wrapper after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(PipelineEditor, {
        canManage: true,
        pipeline: {
          id: "pipeline-1",
          isDefault: true,
          name: "Default",
          stages: [
            {
              approverMemberIds: [],
              description: "Product",
              id: "stage-product",
              name: "Product",
              pipelineId: "pipeline-1",
              position: 1,
              promptTemplateMd: "Product prompt",
              slug: "product",
            },
          ],
        },
        workspaceId,
        workspaceMembers: [],
      }),
    );

    expect(html).toContain("Pipeline name");
    expect(html).toContain("Product");
    expect(html).toContain("Save pipeline");
  });

  it("smoke-renders the Settings Linear section wrapper after extraction", () => {
    const html = renderToStaticMarkup(
      createElement(LinearKeySection, {
        canManage: true,
        isLoadingSecrets: false,
        linearSecret: {
          createdAt: "2026-05-16T18:00:00.000Z",
          createdByMemberId: "member-1",
          id: "secret-1",
          key: "LINEAR_API_KEY",
          updatedAt: "2026-05-16T18:00:00.000Z",
          valuePreview: "••••1234",
          workspaceId,
        },
        setFlashMessage: vi.fn(),
        setSecrets: vi.fn(),
        workspaceId,
      }),
    );

    expect(html).toContain("Linear");
    expect(html).toContain("••••1234");
    expect(html).toContain("Test connection");
  });
});
