// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { SuiteCurationForm } from "./suite-curation-form";
import { TaskCurationEditor } from "./task-curation-editor";

const { push, refresh } = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh }) }));

const id = (suffix: number) => `61300000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const scope = { workspaceId: id(1), factoryId: id(2), workspaceSlug: "acme" };
const task = {
  id: id(3),
  task_id: id(4),
  name: "Invoice UI",
  revision_number: 1,
  tags: ["ui"],
  replay_eligibility: "eligible",
  acceptance_criteria: "Keep the author's original criteria.",
  eligibility_reason: null,
  sourceRunId: id(10),
};
const latest = { ...task, id: id(5), revision_number: 2 };
const draft = {
  suiteId: id(6),
  revisionId: id(7),
  name: "UI regression",
  purpose: "regression",
  selectionTags: ["ui"],
  members: [task],
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
});

it.each([false, true])(
  "requires explicit adoption of a newer task revision (adopt: %s)",
  async (adopt) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<SuiteCurationForm {...scope} draft={draft} taskChoices={[latest]} />);
    expect(screen.getByRole("radio", { name: "Choose tasks" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Invoice UI" })).toBeChecked();
    if (adopt)
      fireEvent.click(screen.getByRole("button", { name: "Use revision 2 for Invoice UI" }));
    fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
    await waitFor(() => expect(push).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      suiteId: draft.suiteId,
      expectedRevisionId: draft.revisionId,
      name: draft.name,
      purpose: draft.purpose,
      selection: { kind: "explicit", taskRevisionIds: [adopt ? latest.id : task.id] },
    });
  },
);

it("keeps the suite draft visible after a stale write", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "The benchmark suite changed." }, { status: 409 })),
  );
  render(<SuiteCurationForm {...scope} draft={draft} taskChoices={[latest]} />);
  const name = screen.getByRole("textbox", { name: "Suite name" });
  fireEvent.change(name, { target: { value: "Updated suite draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Use revision 2 for Invoice UI" }));
  const save = screen.getByRole("button", { name: "Save suite" });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("The benchmark suite changed.");
  expect(name).toHaveValue("Updated suite draft");
  expect(screen.getByRole("button", { name: "Use revision 1 for Invoice UI" })).toBeVisible();
  expect(screen.getByRole("link", { name: "Reload latest revision" })).toBeVisible();
  expect(save).toBeDisabled();
  expect(push).not.toHaveBeenCalled();
});

it("saves a holdout suite by normalized tags with a separately described input", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 1 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SuiteCurationForm {...scope} taskChoices={[latest]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Suite name" }), {
    target: { value: "UI holdout" },
  });
  fireEvent.change(screen.getByRole("combobox", { name: "Suite purpose" }), {
    target: { value: "holdout" },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Match tags" }));
  fireEvent.change(screen.getByRole("textbox", { name: /^Selection tags$/ }), {
    target: { value: " ui, invoice " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    name: "UI holdout",
    purpose: "holdout",
    selection: { kind: "tags", tags: ["ui", "invoice"] },
  });
});

it("keeps edited acceptance criteria on conflict and sends only task revision fields", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ error: "The benchmark task changed." }, { status: 409 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<TaskCurationEditor {...scope} revision={latest} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
  const criteria = screen.getByRole("textbox", { name: "Acceptance criteria" });
  fireEvent.change(criteria, { target: { value: "Revised criteria." } });
  fireEvent.change(screen.getByRole("textbox", { name: "Task tags" }), {
    target: { value: "ui, regression" },
  });
  const save = screen.getByRole("button", { name: "Save task revision" });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("The benchmark task changed.");
  expect(criteria).toHaveValue("Revised criteria.");
  expect(save).toBeDisabled();
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    taskId: latest.task_id,
    expectedRevisionId: latest.id,
    name: latest.name,
    acceptanceCriteria: "Revised criteria.",
    tags: ["ui", "regression"],
  });
  expect(refresh).not.toHaveBeenCalled();
});

it("preserves previously stored tags when acceptance criteria change", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ taskId: latest.task_id, revisionId: id(8), revisionNumber: 3 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<TaskCurationEditor {...scope} revision={{ ...latest, tags: ["ui,accessibility"] }} />);
  fireEvent.click(screen.getByRole("button", { name: "Edit task" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Acceptance criteria" }), {
    target: { value: "Revised criteria." },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save task revision" }));
  await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).tags).toEqual(["ui,accessibility"]);
});

it("offers a way to reload an unavailable factory while preserving the new suite draft", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ error: "This factory is archived." }, { status: 409 })),
  );
  render(<SuiteCurationForm {...scope} taskChoices={[]} />);
  const name = screen.getByRole("textbox", { name: "Suite name" });
  fireEvent.change(name, { target: { value: "Unpublished suite" } });
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("This factory is archived.");
  expect(name).toHaveValue("Unpublished suite");
  expect(screen.getByRole("link", { name: "Reload benchmark suites" })).toHaveAttribute(
    "href",
    `/w/acme/benchmarks?factory=${scope.factoryId}&newSuite=1#new-suite`,
  );
});

it("keeps the selected revision and its review details after newer choices arrive", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 2 }),
  );
  vi.stubGlobal("fetch", fetch);
  const revised = {
    ...latest,
    acceptance_criteria: "Reviewed invoice criteria.",
    eligibility_reason: "The starting ref is unavailable.",
    replay_eligibility: "ineligible",
  };
  const { rerender } = render(
    <SuiteCurationForm {...scope} draft={draft} taskChoices={[revised]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use revision 2 for Invoice UI" }));
  rerender(
    <SuiteCurationForm
      {...scope}
      draft={draft}
      taskChoices={[{ ...latest, id: id(9), revision_number: 3 }]}
    />,
  );
  expect(screen.getByText("Reviewed invoice criteria.")).toBeInTheDocument();
  expect(screen.getByText("The starting ref is unavailable.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use revision 3 for Invoice UI" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  await waitFor(() => expect(push).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).selection).toEqual({
    kind: "explicit",
    taskRevisionIds: [revised.id],
  });
});
