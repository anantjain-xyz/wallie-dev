// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { BenchmarkCatalogEditor } from "./benchmark-catalog-editor";
import { SuiteCurationForm } from "./suite-curation-form";
import { TaskCurationEditor } from "./task-curation-editor";

const { push, refresh, replace } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh, replace }) }));

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
  source: {
    runId: id(10),
    title: "April invoice import",
    stage: "Review",
    attempt: 2,
    createdAt: "2026-11-23T00:00:00Z",
  },
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
const explicitDraft = { ...draft, selectionTags: null };
const previewUrl = `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/benchmarks/suites?suiteId=${draft.suiteId}&expectedRevisionId=${draft.revisionId}`;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  push.mockReset();
  refresh.mockReset();
  replace.mockReset();
});

it.each([false, true])(
  "requires explicit adoption of a newer task revision (adopt: %s)",
  async (adopt) => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 2 }),
    );
    vi.stubGlobal("fetch", fetch);
    render(<SuiteCurationForm {...scope} draft={explicitDraft} taskChoices={[latest]} />);
    expect(screen.getByRole("radio", { name: "Choose tasks" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Include Invoice UI" })).toBeChecked();
    if (adopt)
      fireEvent.click(screen.getByRole("button", { name: "Use revision 2 for Invoice UI" }));
    fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
    await waitFor(() => expect(replace).toHaveBeenCalledOnce());
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
  render(<SuiteCurationForm {...scope} draft={explicitDraft} taskChoices={[latest]} />);
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
  expect(replace).not.toHaveBeenCalled();
});

it("saves a holdout suite by normalized tags with a separately described input", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 1 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SuiteCurationForm {...scope} taskChoices={[{ ...latest, tags: ["ui", "invoice"] }]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Suite name" }), {
    target: { value: "UI holdout" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Suite purpose" }));
  fireEvent.click(screen.getByRole("option", { name: "Holdout" }));
  fireEvent.click(screen.getByRole("radio", { name: "Match tags" }));
  fireEvent.change(screen.getByRole("textbox", { name: /^Selection tags$/ }), {
    target: { value: " UI, invoice " },
  });
  fireEvent.click(screen.getByRole("radio", { name: "Choose tasks" }));
  fireEvent.click(screen.getByRole("radio", { name: "Match tags" }));
  expect(screen.getByRole("textbox", { name: /^Selection tags$/ })).toHaveValue(" UI, invoice ");
  expect(screen.getByRole("button", { name: /^invoice$/ })).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("1 matching task");
  expect(screen.getByText(/Revision 2 · Eligible/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
    name: "UI holdout",
    purpose: "holdout",
    selection: { kind: "tags", tags: ["ui", "invoice"], previewTaskRevisionIds: [latest.id] },
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
  fireEvent.click(screen.getByRole("checkbox", { name: /Save this suite without tasks/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save empty suite" }));
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
    <SuiteCurationForm {...scope} draft={explicitDraft} taskChoices={[revised]} />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Use revision 2 for Invoice UI" }));
  rerender(
    <SuiteCurationForm
      {...scope}
      draft={explicitDraft}
      taskChoices={[{ ...latest, id: id(9), revision_number: 3 }]}
    />,
  );
  expect(screen.getByText("Reviewed invoice criteria.")).toBeInTheDocument();
  expect(screen.getByText("The starting ref is unavailable.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Use revision 3 for Invoice UI" })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body)).selection).toEqual({
    kind: "explicit",
    taskRevisionIds: [revised.id],
  });
});

it("keeps a frozen tag rule and the pinned task revisions on a rename", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 2 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SuiteCurationForm {...scope} draft={draft} taskChoices={[latest]} />);
  expect(screen.getByRole("radio", { name: "Keep frozen selection" })).toBeChecked();
  expect(screen.getByText("Selection tags: ui")).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("1 frozen task");
  expect(screen.getByText(/Revision 1 · Eligible/)).toBeVisible();
  fireEvent.click(screen.getByText("Review Invoice UI"));
  expect(
    screen.getByRole("link", { name: "April invoice import · Review · Attempt 2" }),
  ).toHaveAttribute("href", `/w/acme/runs/${id(10)}?attempt=2`);
  fireEvent.change(screen.getByRole("textbox", { name: "Suite name" }), {
    target: { value: "Renamed suite" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save suite" }));
  await waitFor(() =>
    expect(replace).toHaveBeenCalledWith(
      `/w/acme/benchmarks/${draft.suiteId}?factory=${scope.factoryId}&revision=${id(8)}#suite-membership`,
    ),
  );
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    name: "Renamed suite",
    suiteId: draft.suiteId,
    expectedRevisionId: draft.revisionId,
    selection: { kind: "preserve" },
  });
});

it("requires an intentional empty save, and moving between modes clears consent", async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 1 }),
  );
  vi.stubGlobal("fetch", fetch);
  render(<SuiteCurationForm {...scope} taskChoices={[latest]} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Suite name" }), {
    target: { value: "Future tasks" },
  });
  const consent = () => screen.getByRole("checkbox", { name: /Save this suite without tasks/ });
  fireEvent.click(consent());
  fireEvent.click(screen.getByRole("radio", { name: "Match tags" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Selection tags" }), {
    target: { value: "unknown" },
  });
  expect(screen.getByText(/No tasks match all of these tags/)).toBeVisible();
  expect(screen.getByRole("status")).toHaveTextContent("0 matching tasks");
  const save = screen.getByRole("button", { name: "Save empty suite" });
  expect(consent()).not.toBeChecked();
  expect(save).toBeDisabled();
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(consent());
  fireEvent.click(save);
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
    allowEmpty: true,
    selection: { kind: "tags", tags: ["unknown"], previewTaskRevisionIds: [] },
  });
});

it("shows refresh deltas and keeps the draft when the server finds a changed match", async () => {
  const dropped = { ...task, id: id(11), task_id: id(12), name: "Former match", source: null };
  const matching = { ...latest, tags: ["ui", "invoice"] };
  const restored = { ...matching, id: id(13), revision_number: 3 };
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ error: "Tag matches changed." }, { status: 412 }))
    .mockResolvedValueOnce(Response.json({ taskChoices: [restored] }))
    .mockResolvedValueOnce(
      Response.json({ suiteId: draft.suiteId, revisionId: id(8), revisionNumber: 2 }),
    );
  vi.stubGlobal("fetch", fetch);
  const taggedDraft = { ...draft, members: [task, dropped] };
  render(<SuiteCurationForm {...scope} draft={taggedDraft} taskChoices={[matching]} />);
  const name = screen.getByRole("textbox", { name: "Suite name" });
  fireEvent.change(name, { target: { value: "Updated tag suite" } });
  fireEvent.click(screen.getByRole("radio", { name: "Refresh tag matches" }));
  const tags = screen.getByRole("textbox", { name: "Selection tags" });
  fireEvent.change(tags, { target: { value: " Invoice " } });
  expect(screen.getByRole("status")).toHaveTextContent("1 matching task · 2 previously frozen");
  expect(screen.getByText(/Was revision 1/)).toBeVisible();
  expect(screen.getByText("Would remove: Former match.")).toBeVisible();
  const save = screen.getByRole("button", { name: "Save suite" });
  fireEvent.click(save);
  expect(await screen.findByRole("alert")).toHaveTextContent("Tag matches changed.");
  expect(name).toHaveValue("Updated tag suite");
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Refresh preview" }));
  expect(await screen.findByText(/Revision 3 · Eligible/)).toBeVisible();
  await waitFor(() => expect(save).toBeEnabled());
  expect(fetch).toHaveBeenNthCalledWith(2, previewUrl);
  expect(refresh).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(name).toHaveValue("Updated tag suite");
  expect(tags).toHaveValue(" Invoice ");
  expect(screen.getByRole("radio", { name: "Refresh tag matches" })).toBeChecked();
  fireEvent.click(save);
  await waitFor(() => expect(replace).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({
    suiteId: draft.suiteId,
    expectedRevisionId: draft.revisionId,
    name: "Updated tag suite",
    purpose: "regression",
    selection: { kind: "tags", tags: ["ui", "invoice"], previewTaskRevisionIds: [restored.id] },
  });
});

it("keeps the draft and blocks saving when the preview read detects a newer suite revision", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ error: "Tag matches changed." }, { status: 412 }))
    .mockResolvedValueOnce(
      Response.json({ error: "The benchmark suite changed." }, { status: 409 }),
    );
  vi.stubGlobal("fetch", fetch);
  render(
    <SuiteCurationForm
      {...scope}
      draft={draft}
      taskChoices={[{ ...latest, tags: ["ui", "invoice"] }]}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Suite name" });
  fireEvent.change(name, { target: { value: "Unsaved draft" } });
  const mode = screen.getByRole("radio", { name: "Refresh tag matches" });
  fireEvent.click(mode);
  const tags = screen.getByRole("textbox", { name: "Selection tags" });
  fireEvent.change(tags, { target: { value: "Invoice" } });
  const save = screen.getByRole("button", { name: "Save suite" });
  fireEvent.click(save);
  fireEvent.click(await screen.findByRole("button", { name: "Refresh preview" }));

  expect(await screen.findByText("The benchmark suite changed.")).toBeVisible();
  expect(fetch).toHaveBeenNthCalledWith(2, previewUrl);
  expect(name).toHaveValue("Unsaved draft");
  expect(tags).toHaveValue("Invoice");
  expect(mode).toBeChecked();
  expect(screen.getByText(/Revision 2 · Eligible/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Reload latest revision" })).toBeVisible();
  expect(save).toBeDisabled();
  fireEvent.submit(screen.getByRole("form", { name: "Edit suite" }));
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(refresh).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
});

it("guards switching a dirty draft and preserves the named filters after a confirmed switch", async () => {
  const confirm = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
  vi.stubGlobal("confirm", confirm);
  const catalogHref = `/w/acme/benchmarks?factory=${scope.factoryId}&q=invoice&purpose=holdout&after=${id(8)}`;
  render(
    <BenchmarkCatalogEditor
      {...scope}
      catalogHref={catalogHref}
      taskChoices={[task]}
      factories={[
        { id: scope.factoryId, isDefault: true, name: "Primary", status: "active" },
        { id: id(9), isDefault: false, name: "Secondary", status: "active" },
      ]}
    />,
  );
  expect(screen.getByRole("link", { name: "Cancel" })).toHaveAttribute("href", catalogHref);
  const name = screen.getByRole("textbox", { name: "Suite name" });
  expect(name).toHaveFocus();
  fireEvent.change(name, { target: { value: "Draft invoice suite" } });
  const change = () => {
    fireEvent.click(screen.getByRole("combobox", { name: "Factory" }));
    fireEvent.click(screen.getByRole("option", { name: "Secondary" }));
  };
  change();
  expect(confirm).toHaveBeenCalledOnce();
  expect(push).not.toHaveBeenCalled();
  expect(name).toHaveValue("Draft invoice suite");
  change();
  expect(push).toHaveBeenCalledWith(
    `/w/acme/benchmarks?factory=${id(9)}&q=invoice&purpose=holdout`,
  );
});
