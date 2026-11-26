// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { CalibrationForm } from "./scorer-governance-controls";
import { ScorerGovernanceSection } from "./scorer-governance-section";

const { refresh } = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

const id = (suffix: number) => `60900000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const at = "2026-11-19T23:30:00Z";
const refs = (...ids: string[]) =>
  ids.map((adjudication_id) => ({
    adjudication_id,
    attempt_id: id(7),
    run_id: id(11),
    session_title: "Saved invoice run",
    stage_name: "Build",
    attempt_number: 1,
  }));
const current = {
  id: id(1),
  set_id: id(2),
  revision: 3,
  name: "Initial set",
  scorer_revision_id: id(3),
  scorer_revision_number: 2,
  adjudication_ids: [id(4), id(5)],
  case_refs: [refs(id(4))[0]!, { adjudication_id: id(5), attempt_id: null, run_id: null }],
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
  session_title: note,
}));
const candidatePage = {
  candidates,
  next_before_candidate_at: null,
  next_before_candidate_id: null,
};

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
        case_refs: refs(id(4), id(5), id(6)),
      },
    }),
  );
  vi.stubGlobal("fetch", submit);
  render(
    <CalibrationForm
      current={current}
      candidatePage={candidatePage}
      endpoint="/governance"
      workspaceSlug="wallie"
      scorerRevisionId={id(12)}
    />,
  );
  expect(screen.getByRole("checkbox", { name: /Saved invoice run/ })).toBeChecked();
  expect(screen.getByRole("checkbox", { name: /Recent selected case/ })).toBeChecked();
  fireEvent.click(screen.getByRole("checkbox", { name: /New case/ }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "new case" } });
  expect(screen.queryByRole("checkbox", { name: /Saved invoice run/ })).not.toBeInTheDocument();
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
      candidatePage={candidatePage}
      endpoint="/governance"
      workspaceSlug="wallie"
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

it("appends an older case page without resetting the draft or prior checkbox choices", async () => {
  const cursor = "2026-11-19T23:30:00.123456+00:00";
  const ids = [id(5), id(6), id(8)];
  const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json({
          action: "calibration",
          calibration: {
            ...current,
            name: "Draft after paging",
            revision: 4,
            adjudication_ids: ids,
            case_refs: refs(...ids),
          },
        })
      : Response.json({
          candidates: [
            {
              ...candidates[0],
              id: id(4),
              note: "Previously hidden saved case",
              session_title: "Previously hidden saved case",
            },
            {
              ...candidates[0],
              id: id(8),
              note: "Another older case",
              session_title: "Another older case",
            },
          ],
          next_before_candidate_at: null,
          next_before_candidate_id: null,
        }),
  );
  vi.stubGlobal("fetch", fetcher);
  render(
    <CalibrationForm
      current={current}
      candidatePage={{
        ...candidatePage,
        next_before_candidate_at: cursor,
        next_before_candidate_id: id(5),
      }}
      endpoint="/governance"
      workspaceSlug="wallie"
      scorerRevisionId={id(12)}
    />,
  );
  fireEvent.change(screen.getByLabelText("Calibration set name"), {
    target: { value: "Draft after paging" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: /Saved invoice run/ }));
  fireEvent.click(screen.getByRole("checkbox", { name: /New case/ }));
  fireEvent.click(screen.getByRole("button", { name: "Load older calibration cases" }));
  expect(
    await screen.findByRole("checkbox", { name: /Previously hidden saved case/ }),
  ).not.toBeChecked();
  expect(screen.getByRole("checkbox", { name: /New case/ })).toBeChecked();
  expect(screen.getByLabelText("Calibration set name")).toHaveValue("Draft after paging");
  expect(
    new URL(fetcher.mock.calls[0]?.[0] ?? "", "https://wallie.test").searchParams.get(
      "beforeCandidateAt",
    ),
  ).toBe(cursor);
  fireEvent.click(screen.getByRole("checkbox", { name: /Another older case/ }));
  fireEvent.click(screen.getByRole("button", { name: "Publish next version" }));
  expect(await screen.findByText("Calibration version published.")).toBeVisible();
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    scorerRevisionId: current.scorer_revision_id,
    name: "Draft after paging",
    adjudicationIds: ids,
  });
});

it("links a reader to the rubric and exact attempts retained in the calibration version", () => {
  render(
    <ScorerGovernanceSection
      workspaceSlug="wallie"
      scope={{ workspaceId: id(20), factoryId: id(21) }}
      scorerId={id(23)}
      scorerRevisionNumber={3}
      scorerRevisionId={id(12)}
      canEdit={false}
      path="/w/wallie/scorers/detail"
      data={{
        pause: {
          paused: false,
          revision: 3,
          updated_at: at,
          history: [{ revision: 2, paused: true, actor_name: "Scorer Manager", created_at: at }],
          next_before_pause_revision: 2,
        },
        beforePauseRevision: 3,
        selection: { calibrationSet: current.set_id },
        calibration: {
          ...candidatePage,
          versions: [current],
          next_before_revision: null,
          next_before_set_at: null,
          next_before_set_id: null,
        },
      }}
    />,
  );
  const rubric = screen.getByRole("link", { name: "Pinned rubric · Revision 2" });
  expect(screen.getByText("Admitting evaluations")).toBeVisible();
  expect(screen.getByText("Pause revision 2")).toBeVisible();
  expect(screen.getByText("Scorer Manager")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Pause scorer" })).toBeNull();
  const nextPause = new URL(
    screen.getByRole("link", { name: "Older pause changes" }).getAttribute("href") ?? "",
    "https://wallie.test",
  );
  expect(nextPause.searchParams.get("beforePauseRevision")).toBe("2");
  expect(nextPause.searchParams.get("calibrationSet")).toBe(current.set_id);
  expect(
    new URL(rubric.getAttribute("href") ?? "", "https://wallie.test").searchParams.get("revision"),
  ).toBe(current.scorer_revision_id);
  fireEvent.click(screen.getByText("Inspect calibration cases"));
  expect(screen.getByText("Saved case 2 · Details unavailable")).toBeVisible();
  const caseLink = screen.getByRole("link", {
    name: "Saved invoice run · Build · Evaluation attempt 1",
  });
  expect(caseLink.getAttribute("href")).toBe(
    `/w/wallie/runs/${id(11)}?evaluationAttempt=${id(7)}&evaluationAdjudication=${id(4)}#adjudication-${id(4)}`,
  );
});
