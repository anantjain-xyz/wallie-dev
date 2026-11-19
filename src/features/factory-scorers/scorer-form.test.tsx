// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

const workspaceId = "9f300000-0000-4000-8000-000000000001";
const factoryId = "9f300000-0000-4000-8000-000000000002";
const scorerId = "9f300000-0000-4000-8000-000000000003";
const revisionId = "9f300000-0000-4000-8000-000000000004";
const props = { workspaceId, factoryId, workspaceSlug: "acme" };
const scorerHref = `/w/acme/scorers/${scorerId}?factory=${factoryId}`;
const api = `/api/workspaces/${workspaceId}/factories/${factoryId}/scorers`;
const original: FactoryScorerDefinition = {
  schemaVersion: 1,
  rubric: "Does the diff cover the acceptance criteria?",
  requiredEvidence: ["code_diff"],
  scoring: { kind: "boolean", passValue: true },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
});

it("validates numeric thresholds locally and publishes the exact valid rubric", async () => {
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    const { definition } = JSON.parse(String(init.body));
    return Response.json(
      {
        revision: {
          id: revisionId,
          scorer_id: scorerId,
          revision_number: 1,
          definition,
          created_at: "2026-11-19T23:00:00Z",
        },
      },
      { status: 201 },
    );
  });
  vi.stubGlobal("fetch", fetch);
  render(<ScorerForm {...props} draft={{ kind: "create" }} />);
  for (const [name, value] of [
    ["Scorer name", "Change quality"],
    ["Identifier", "change-quality"],
    ["Rubric", original.rubric],
    ["Score scale", "numeric"],
    ["Minimum score", "0"],
    ["Maximum score", "10"],
    ["Pass threshold", "8"],
    ["Fail threshold", "8"],
  ]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Code diff" }));
  fireEvent.click(screen.getByRole("button", { name: "Validate rubric" }));
  expect(screen.getByRole("alert")).toHaveTextContent("inclusive pass and fail intervals");
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Fail threshold"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate rubric" }));
  expect(screen.getByRole("status")).toHaveTextContent("Rubric is valid.");
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Publish scorer" }));
  await waitFor(() => expect(push).toHaveBeenCalledWith(`${scorerHref}&revision=${revisionId}`));
  expect(fetch.mock.calls[0]?.[0]).toBe(api);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toEqual({
    name: "Change quality",
    slug: "change-quality",
    definition: {
      ...original,
      scoring: {
        kind: "numeric",
        min: 0,
        max: 10,
        direction: "higher_is_better",
        passThreshold: 8,
        failThreshold: 4,
      },
    },
  });
});

it("keeps a stale rubric draft and requires a reload before another publish", async () => {
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>(async () =>
    Response.json({ error: "The scorer changed. Reload before publishing." }, { status: 409 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(
    <ScorerForm
      {...props}
      draft={{ kind: "revise", scorerId, expectedRevisionNumber: 1, definition: original }}
    />,
  );
  const rubric = screen.getByRole("textbox", { name: "Rubric" });
  fireEvent.change(rubric, { target: { value: "Preserve my edits." } });
  const publish = screen.getByRole("button", { name: "Publish revision" });
  fireEvent.click(publish);
  expect(await screen.findByRole("alert")).toHaveTextContent("Reload before publishing.");
  expect(rubric).toHaveValue("Preserve my edits.");
  expect(publish).toBeDisabled();
  expect(screen.getByRole("link", { name: "Reload latest revision" })).toHaveAttribute(
    "href",
    scorerHref,
  );
  expect(fetch.mock.calls[0]?.[0]).toBe(`${api}/${scorerId}/revisions`);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toEqual({
    expectedRevisionNumber: 1,
    definition: { ...original, rubric: "Preserve my edits." },
  });
  expect(push).not.toHaveBeenCalled();
});
