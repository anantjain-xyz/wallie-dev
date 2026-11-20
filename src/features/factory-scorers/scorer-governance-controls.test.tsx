// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { CalibrationForm } from "./scorer-governance-controls";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const id = (suffix: number) => `60900000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const at = "2026-11-19T23:30:00Z";
const current = {
  id: id(1),
  set_id: id(2),
  revision: 3,
  name: "Initial set",
  scorer_revision_id: id(3),
  adjudication_ids: [id(4), id(5)],
  created_at: at,
};
const candidates = [
  { id: id(6), note: "New case" },
  { id: id(5), note: "Recent selected case" },
].map(({ id: caseId, note }) => ({
  id: caseId,
  attempt_id: id(7),
  disposition: "confirmed" as const,
  expected_status: null,
  status: "pass" as const,
  reason: null,
  created_at: at,
  note,
}));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  refresh.mockReset();
});

it("keeps earlier cases in their saved order and appends newly selected cases", async () => {
  const submit = vi.fn(async () =>
    Response.json({
      action: "calibration",
      calibration: {
        ...current,
        revision: 4,
        name: "Renamed set",
        adjudication_ids: [id(4), id(5), id(6)],
      },
    }),
  );
  vi.stubGlobal("fetch", submit);
  render(
    <CalibrationForm
      current={current}
      candidates={candidates}
      endpoint="/governance"
      scorerRevisionId={current.scorer_revision_id}
    />,
  );
  expect(screen.getByRole("checkbox", { name: /Earlier case/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Recent selected case/ })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /New case/ }));
  fireEvent.change(screen.getByLabelText("Calibration set name"), {
    target: { value: "Renamed set" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish next version" }));
  expect(await screen.findByText("Calibration version published.")).toBeVisible();
  expect(submit).toHaveBeenCalledWith(
    "/governance",
    expect.objectContaining({
      body: JSON.stringify({
        action: "calibration",
        setId: current.set_id,
        expectedRevision: 3,
        scorerRevisionId: current.scorer_revision_id,
        name: "Renamed set",
        adjudicationIds: [id(4), id(5), id(6)],
      }),
    }),
  );
  expect(refresh).toHaveBeenCalledOnce();
});

it("retains the calibration draft on a stale revision while controls reload", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "Reload before retrying." }, { status: 409 })),
  );
  render(
    <CalibrationForm
      current={current}
      candidates={candidates}
      endpoint="/governance"
      scorerRevisionId={current.scorer_revision_id}
    />,
  );
  fireEvent.change(screen.getByLabelText("Calibration set name"), {
    target: { value: "Draft update" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Publish next version" }));
  await screen.findByRole("alert");
  expect(screen.getByRole("button", { name: "Publish next version" })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Reload controls" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(screen.getByLabelText("Calibration set name")).toHaveValue("Draft update");
});
