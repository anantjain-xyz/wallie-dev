// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeliveryPolicySection } from "@/features/settings/delivery-policy-section";
import type { DeliveryPolicy } from "@/lib/delivery-policy/contracts";

const workspaceId = "00000000-0000-4000-8000-000000000002";
const pipelineId = "00000000-0000-4000-8000-000000000001";
const policy: DeliveryPolicy = {
  id: "00000000-0000-4000-8000-000000000003",
  workspaceId,
  pipelineId,
  revision: 3,
  createdAt: "2026-11-06T00:00:00Z",
  requirements: {
    version: 1,
    deliveryMode: "code",
    requiredChecks: ["test", "lint"],
    minimumApprovals: 1,
    requireCodeOwnerReview: true,
    requireResolvedThreads: true,
    requiredEvidence: ["browser-proof"],
    freshnessSeconds: 3600,
    requireArtifactApprovalForDelivery: false,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(canManage = true) {
  return render(
    <main>
      <DeliveryPolicySection
        canManage={canManage}
        pipelineId={pipelineId}
        workspaceId={workspaceId}
      />
    </main>,
  );
}

describe("delivery policy settings", () => {
  it("loads an explicit saved policy without writing and exposes accessible controls", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ policy }));
    vi.stubGlobal("fetch", fetch);
    const { container } = mount();
    expect(
      await screen.findByRole("textbox", { name: /^Required GitHub checks/ }),
    ).toBeInTheDocument();
    expect(screen.getByText("Revision 3")).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toHaveProperty("violations", []);
  });

  it("creates no policy until explicit submit, sends all requirements, and adopts the returned revision", async () => {
    let finishSave!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finishSave = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ policy: null }))
      .mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount();
    const save = await screen.findByRole("button", { name: "Create delivery policy" });
    expect(fetch).toHaveBeenCalledTimes(1);
    await user.click(
      screen.getByRole("radio", { name: "Analysis only (PR readiness not applicable)" }),
    );
    fireEvent.click(save);
    fireEvent.click(save);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    const request = JSON.parse(fetch.mock.calls[1][1].body);
    expect(request).toEqual({
      pipelineId,
      expectedRevision: 0,
      requirements: {
        version: 1,
        deliveryMode: "analysis",
        requiredChecks: [],
        requiredEvidence: [],
        minimumApprovals: 0,
        requireCodeOwnerReview: false,
        requireResolvedThreads: true,
        freshnessSeconds: 3600,
        requireArtifactApprovalForDelivery: false,
      },
    });
    await act(async () =>
      finishSave(
        Response.json({ policy: { ...policy, revision: 1, requirements: request.requirements } }),
      ),
    );
    expect(await screen.findByText("Revision 1")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("revision saved");
  });

  it("preserves the draft on a stale revision and requires an explicit reload before resubmitting", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ policy }))
      .mockResolvedValueOnce(Response.json({ error: "Stale revision" }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ policy: { ...policy, revision: 4 } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount();
    const checks = await screen.findByRole("textbox", { name: /^Required GitHub checks/ });
    await user.clear(checks);
    await user.type(checks, "new-check");
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Policy changed. Reload before retrying.",
    );
    expect(checks).toHaveValue("new-check");
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeDisabled();
    expect(JSON.parse(fetch.mock.calls[1][1].body).expectedRevision).toBe(3);
    await user.click(screen.getByRole("button", { name: "Reload saved policy" }));
    expect(await screen.findByText("Revision 4")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /^Required GitHub checks/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeEnabled();
  });

  it("does not expose a default draft after a failed or malformed load", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "No access" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ policy: { ...policy, requirements: {} } }));
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("No access");
    expect(
      screen.queryByRole("button", { name: "Create delivery policy" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry loading policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid delivery policy");
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("keeps policy settings read-only for ordinary members", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ policy })));
    mount(false);
    expect(await screen.findByRole("textbox", { name: /^Required GitHub checks/ })).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: "Require code owner review" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save new revision" })).not.toBeInTheDocument();
  });

  it("cannot apply a previous pipeline's delayed response after the selection changes", async () => {
    let finish!: (value: Response) => void;
    const delayed = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    const fetch = vi
      .fn()
      .mockReturnValueOnce(delayed)
      .mockResolvedValueOnce(Response.json({ policy: null }));
    vi.stubGlobal("fetch", fetch);
    const { rerender } = mount();
    rerender(
      <DeliveryPolicySection
        canManage
        pipelineId="00000000-0000-4000-8000-000000000004"
        workspaceId={workspaceId}
      />,
    );
    await screen.findByRole("button", { name: "Create delivery policy" });
    await act(async () => finish(Response.json({ policy })));
    await waitFor(() => expect(screen.queryByText("Revision 3")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Create delivery policy" })).toBeEnabled();
  });
});
