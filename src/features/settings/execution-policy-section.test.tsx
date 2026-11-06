// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ExecutionPolicySection } from "@/features/settings/execution-policy-section";
import type { ExecutionPolicy } from "@/lib/execution-policy/contracts";

const workspaceId = "00000000-0000-4000-8000-000000000002";
const policy: ExecutionPolicy = {
  id: "00000000-0000-4000-8000-000000000003",
  workspaceId,
  revision: 3,
  createdAt: "2026-11-06T00:00:00Z",
  requirements: {
    version: 1,
    maxRepairAttempts: 2,
    maxExecutionMs: 5_400_000,
    maxTotalTokens: 250_000,
    maxCostUsd: 9.75,
  },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mount(canManage = true) {
  return render(
    <main>
      <ExecutionPolicySection canManage={canManage} workspaceId={workspaceId} />
    </main>,
  );
}

describe("execution policy settings", () => {
  it("loads a saved policy, converts elapsed milliseconds to minutes, and exposes accessible controls", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ policy }));
    vi.stubGlobal("fetch", fetch);
    const { container } = mount();
    expect(await screen.findByRole("spinbutton", { name: /^Maximum repair attempts/ })).toHaveValue(
      2,
    );
    expect(screen.getByRole("spinbutton", { name: /^Maximum agent execution time/ })).toHaveValue(
      90,
    );
    expect(screen.getByRole("spinbutton", { name: /^Maximum total tokens/ })).toHaveValue(250000);
    expect(screen.getByRole("spinbutton", { name: /^Maximum cost/ })).toHaveValue(9.75);
    expect(screen.getByText("Revision 3")).toBeInTheDocument();
    expect(screen.getByText(/revisions? pins to new sessions only/i)).toBeInTheDocument();
    expect(screen.getByText(/excluding review idle/i)).toBeInTheDocument();
    expect(screen.getByText(/unavailable finalized measurements/i)).toBeInTheDocument();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]?.method).toBeUndefined();
    expect(
      await axe.run(container, { rules: { "color-contrast": { enabled: false } } }),
    ).toHaveProperty("violations", []);
  });

  it("uses the explicit defaults and nullable limits only after an explicit submit", async () => {
    let finishSave!: (value: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      finishSave = resolve;
    });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ policy: null }))
      .mockReturnValueOnce(pending);
    vi.stubGlobal("fetch", fetch);
    mount();
    const save = await screen.findByRole("button", { name: "Create execution policy" });
    expect(screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ })).toHaveValue(3);
    expect(screen.getByRole("spinbutton", { name: /^Maximum agent execution time/ })).toHaveValue(
      60,
    );
    expect(screen.getByRole("spinbutton", { name: /^Maximum total tokens/ })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: /^Maximum cost/ })).toHaveValue(null);
    expect(fetch).toHaveBeenCalledTimes(1);
    fireEvent.click(save);
    fireEvent.click(save);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    const request = JSON.parse(fetch.mock.calls[1][1].body);
    expect(request).toEqual({
      expectedRevision: 0,
      requirements: {
        version: 1,
        maxRepairAttempts: 3,
        maxExecutionMs: 3_600_000,
        maxTotalTokens: null,
        maxCostUsd: null,
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

  it("converts edited minutes to milliseconds and sends cleared optional limits as null", async () => {
    const savedRequirements = {
      ...policy.requirements,
      maxRepairAttempts: 0,
      maxExecutionMs: 90_000,
      maxTotalTokens: null,
      maxCostUsd: null,
    };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ policy }))
      .mockResolvedValueOnce(
        Response.json({
          policy: { ...policy, revision: 4, requirements: savedRequirements },
        }),
      );
    vi.stubGlobal("fetch", fetch);
    const user = userEvent.setup();
    mount();
    const repairs = await screen.findByRole("spinbutton", { name: /^Maximum repair attempts/ });
    fireEvent.change(repairs, { target: { value: "0" } });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Maximum agent execution time/ }), {
      target: { value: "1.5" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Maximum total tokens/ }), {
      target: { value: "" },
    });
    fireEvent.change(screen.getByRole("spinbutton", { name: /^Maximum cost/ }), {
      target: { value: "" },
    });
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      expectedRevision: 3,
      requirements: savedRequirements,
    });
    expect(await screen.findByText("Revision 4")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /^Maximum total tokens/ })).toHaveValue(null);
    expect(screen.getByRole("spinbutton", { name: /^Maximum cost/ })).toHaveValue(null);
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
    const repairs = await screen.findByRole("spinbutton", { name: /^Maximum repair attempts/ });
    fireEvent.change(repairs, { target: { value: "7" } });
    await user.click(screen.getByRole("button", { name: "Save new revision" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("changed while you were editing");
    expect(repairs).toHaveValue(7);
    expect(screen.getByRole("button", { name: "Save new revision" })).toBeDisabled();
    expect(JSON.parse(fetch.mock.calls[1][1].body).expectedRevision).toBe(3);
    await user.click(screen.getByRole("button", { name: "Reload saved policy" }));
    expect(await screen.findByText("Revision 4")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: /^Maximum repair attempts/ })).toHaveValue(2);
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
      screen.queryByRole("button", { name: "Create execution policy" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry loading policy" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("invalid execution policy");
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("keeps policy settings read-only for ordinary members", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({ policy })));
    mount(false);
    expect(
      await screen.findByRole("spinbutton", { name: /^Maximum repair attempts/ }),
    ).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: /^Maximum total tokens/ })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Save new revision" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload saved policy" })).toBeEnabled();
  });
});
