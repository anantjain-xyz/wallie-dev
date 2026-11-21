// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { routingDraftRequestSchema } from "@/lib/model-routing/draft-contracts";

import { ApplyToRoutingButton, BenchmarkRoutingDraft } from "./benchmark-routing-draft";

const id = (number: number) => `8a99b000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const context = {
  workspaceId: id(1),
  workspaceSlug: "delivery-team",
  factoryId: id(2),
  experimentId: id(3),
  suiteRevisionId: id(4),
  scorerRevisionId: id(5),
  qualityFloorBps: 8275,
  minimumResolved: 8,
};
const candidate = { key: "a".repeat(64), label: "Candidate · Codex" };

function renderRoutingDraft() {
  render(
    <PortalRootProvider>
      <BenchmarkRoutingDraft context={context}>
        <ApplyToRoutingButton candidate={candidate} />
      </BenchmarkRoutingDraft>
    </PortalRootProvider>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Apply to routing" }));
  return within(screen.getByRole("dialog", { name: "Apply to routing" }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("retains an unchanged draft request on retry and opens the exact saved draft", async () => {
  const fetchDraft = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error("Connection lost."))
    .mockResolvedValueOnce(
      Response.json({ error: "The capability qualification expired." }, { status: 422 }),
    )
    .mockResolvedValueOnce(Response.json({ draftId: id(6), canonicalDigest: "b".repeat(64) }));
  vi.stubGlobal("fetch", fetchDraft);

  const dialog = renderRoutingDraft();
  expect(dialog.getByRole("spinbutton", { name: "Quality floor (%)" })).toHaveValue(82.75);
  expect(dialog.getByRole("spinbutton", { name: "Minimum resolved trials" })).toHaveValue(8);
  fireEvent.change(dialog.getByRole("textbox", { name: "Task class name" }), {
    target: { value: "Bug fix" },
  });
  fireEvent.change(dialog.getByRole("textbox", { name: "Task class slug" }), {
    target: { value: "bug-fix" },
  });
  fireEvent.change(dialog.getByRole("spinbutton", { name: "Maximum mean cost (USD)" }), {
    target: { value: "0.25" },
  });
  const submit = () =>
    fireEvent.click(dialog.getByRole("button", { name: "Create routing draft" }));

  submit();
  expect(await dialog.findByRole("alert")).toHaveTextContent("Connection lost.");
  submit();
  expect(await dialog.findByRole("alert")).toHaveTextContent(
    "The capability qualification expired.",
  );
  expect(dialog.queryByRole("link", { name: "Open routing draft" })).not.toBeInTheDocument();
  submit();

  expect(await dialog.findByRole("link", { name: "Open routing draft" })).toHaveAttribute(
    "href",
    `/w/delivery-team/settings/factory-definition?factory=${id(2)}&draft=${id(6)}`,
  );
  expect(dialog.getByRole("status")).toHaveTextContent("Routing draft created.");
  fireEvent.click(dialog.getByRole("button", { name: /^Close$/ }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Apply to routing" })).toHaveFocus(),
  );
  const requests = fetchDraft.mock.calls.map(([endpoint, options]) => {
    expect(endpoint).toBe(
      `/api/workspaces/${id(1)}/factories/${id(2)}/benchmarks/experiments/${id(3)}/routing-drafts`,
    );
    expect(options?.method).toBe("POST");
    return routingDraftRequestSchema.parse(JSON.parse(String(options?.body)));
  });
  expect(requests).toHaveLength(3);
  expect(requests).toEqual([requests[0], requests[0], requests[0]]);
  expect(requests[0]).toMatchObject({
    candidateKey: candidate.key,
    suiteRevisionId: id(4),
    scorerRevisionId: id(5),
    taskClass: { slug: "bug-fix", name: "Bug fix" },
    constraints: {
      qualityFloorBps: 8275,
      minResolvedTrials: 8,
      maxMeanCostUsd: 0.25,
      maxLatencyMs: null,
      minConfidenceBps: null,
    },
  });
});
