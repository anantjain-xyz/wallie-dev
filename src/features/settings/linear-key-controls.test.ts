import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { LinearKeyControls } from "@/features/settings/linear-key-controls";

describe("LinearKeyControls", () => {
  it("renders the save-key state when no Linear key is configured", () => {
    const html = renderToStaticMarkup(
      createElement(LinearKeyControls, {
        canManage: true,
        linearSecret: null,
        setFlashMessage: vi.fn(),
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(html).toContain("Linear API Key");
    expect(html).toContain('type="password"');
    expect(html).toContain("Save key");
    expect(html).not.toContain("Test connection");
  });

  it("renders only preview metadata and the test action when a key is configured", () => {
    const html = renderToStaticMarkup(
      createElement(LinearKeyControls, {
        canManage: true,
        linearSecret: {
          createdAt: "2026-05-16T18:00:00.000Z",
          createdByMemberId: "member-1",
          id: "secret-1",
          key: "LINEAR_API_KEY",
          updatedAt: "2026-05-16T18:00:00.000Z",
          valuePreview: "••••1234",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        },
        setFlashMessage: vi.fn(),
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(html).toContain("Linear API key configured");
    expect(html).toContain("••••1234");
    expect(html).toContain("Test connection");
    expect(html).not.toContain("lin_api_plaintext");
  });

  it("can expose a replacement input without returning secret material", () => {
    const html = renderToStaticMarkup(
      createElement(LinearKeyControls, {
        allowDelete: false,
        allowReplace: true,
        canManage: true,
        linearSecret: {
          createdAt: "2026-05-16T18:00:00.000Z",
          createdByMemberId: "member-1",
          id: "secret-1",
          key: "LINEAR_API_KEY",
          updatedAt: "2026-05-16T18:00:00.000Z",
          valuePreview: "••••1234",
          workspaceId: "00000000-0000-4000-8000-000000000001",
        },
        setFlashMessage: vi.fn(),
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }),
    );

    expect(html).toContain("Replace Linear API key");
    expect(html).toContain('type="password"');
    expect(html).toContain("Save key");
    expect(html).toContain("Test connection");
    expect(html).not.toContain("Remove");
    expect(html).not.toContain("lin_api_plaintext");
  });
});
