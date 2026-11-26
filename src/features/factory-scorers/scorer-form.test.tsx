// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { ScorerDraftGuard } from "@/features/factory-scorers/scorer-draft-guard";
import { ScorerFactorySelector } from "@/features/factory-scorers/scorer-factory-selector";
import { ScorerForm } from "@/features/factory-scorers/scorer-form";
import type { FactoryScorerDefinition } from "@/lib/factory-scorers/contracts";
import { factoryScorerPresets } from "@/lib/factory-scorers/presets";

const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push }),
  usePathname: () => "/w/acme/scorers",
  useSearchParams: () => new URLSearchParams("preset=verification-v1&q=invoice"),
}));

const workspaceId = "9f300000-0000-4000-8000-000000000001";
const factoryId = "9f300000-0000-4000-8000-000000000002";
const scorerId = "9f300000-0000-4000-8000-000000000003";
const revisionId = "9f300000-0000-4000-8000-000000000004";
const props = { workspaceId, factoryId, factoryLabel: "Invoices", workspaceSlug: "acme" };
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
  fireEvent.click(screen.getByText("Advanced"));
  for (const [name, value] of [
    ["Scorer name", "Change quality"],
    ["Identifier", "change-quality"],
    ["Rubric", original.rubric],
  ]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  }
  fireEvent.click(screen.getByRole("combobox", { name: "Score scale" }));
  fireEvent.click(screen.getByRole("option", { name: "Numeric" }));
  for (const [name, value] of [
    ["Minimum score", "0"],
    ["Maximum score", "10"],
    ["Pass threshold", "8"],
    ["Fail threshold", "8"],
  ]) {
    fireEvent.change(screen.getByLabelText(name), { target: { value } });
  }
  fireEvent.click(screen.getByRole("checkbox", { name: "Code diff" }));
  fireEvent.click(screen.getByRole("button", { name: "Validate rubric" }));
  expect(screen.getByLabelText("Fail threshold")).toHaveFocus();
  expect(screen.getByLabelText("Fail threshold")).toHaveAccessibleDescription(
    /below the pass threshold/,
  );
  expect(screen.getByRole("alert")).toHaveTextContent("inclusive pass and fail intervals");
  expect(fetch).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Fail threshold"), { target: { value: "4" } });
  fireEvent.click(screen.getByRole("button", { name: "Validate rubric" }));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Rubric settings are valid. No runs were evaluated.",
  );
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Publish scorer" }));
  await waitFor(() =>
    expect(push).toHaveBeenCalledWith(
      `${scorerHref}&revision=${revisionId}&published=${revisionId}`,
    ),
  );
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
    Response.json(
      { error: "The scorer changed. Reload before publishing.", code: "stale_revision" },
      { status: 409 },
    ),
  );
  vi.stubGlobal("fetch", fetch);
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", Object.assign(Object.create(navigator), { clipboard: { writeText } }));
  render(
    <PortalRootProvider>
      <ScorerDraftGuard>
        <ScorerForm
          {...props}
          draft={{ kind: "revise", scorerId, expectedRevisionNumber: 1, definition: original }}
        />
      </ScorerDraftGuard>
    </PortalRootProvider>,
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
  fireEvent.click(screen.getByRole("link", { name: "Reload latest revision" }));
  expect(screen.getByRole("alertdialog")).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(rubric).toHaveValue("Preserve my edits.");
  fireEvent.click(screen.getByRole("button", { name: "Copy draft" }));
  await screen.findByText("Draft copied, including both score scales.");
  expect(JSON.parse(writeText.mock.calls[0]?.[0])).toMatchObject({
    rubric: "Preserve my edits.",
    scale: "boolean",
    passValue: "true",
  });
  expect(fetch.mock.calls[0]?.[0]).toBe(`${api}/${scorerId}/revisions`);
  expect(JSON.parse(String(fetch.mock.calls[0]?.[1].body))).toEqual({
    expectedRevisionNumber: 1,
    definition: { ...original, rubric: "Preserve my edits." },
  });
  expect(push).not.toHaveBeenCalled();
});

it("preserves both scales and confirms restore or a factory switch only for a dirty draft", () => {
  const preset = factoryScorerPresets.correctness;
  const secondFactoryId = "9f300000-0000-4000-8000-000000000006";
  render(
    <PortalRootProvider>
      <ScorerDraftGuard>
        <ScorerFactorySelector
          selectedValue={factoryId}
          factories={[
            {
              id: factoryId,
              name: "Invoices",
              slug: "invoices",
              isDefault: true,
              status: "active",
            },
            {
              id: secondFactoryId,
              name: "Invoices",
              slug: "invoices-qa",
              isDefault: false,
              status: "active",
            },
          ]}
        />
        <ScorerForm {...props} draft={{ kind: "create", preset }} />
      </ScorerDraftGuard>
    </PortalRootProvider>,
  );
  const restore = screen.getByRole("button", { name: "Restore preset" });
  fireEvent.click(restore);
  expect(screen.queryByRole("alertdialog")).toBeNull();
  function choose(field: string, option: string) {
    fireEvent.click(screen.getByRole("combobox", { name: field }));
    fireEvent.click(screen.getByRole("option", { name: option }));
  }
  choose("Passing value", "False");
  choose("Score scale", "Numeric");
  fireEvent.change(screen.getByLabelText("Minimum score"), { target: { value: "4" } });
  choose("Better score", "Lower");
  choose("Score scale", "Boolean");
  expect(screen.getByRole("combobox", { name: "Passing value" })).toHaveTextContent("False");
  choose("Score scale", "Numeric");
  expect(screen.getByLabelText("Minimum score")).toHaveValue(4);
  expect(screen.getByRole("combobox", { name: "Better score" })).toHaveTextContent("Lower");
  choose("Factory", "Invoices · invoices-qa");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(push).not.toHaveBeenCalled();
  fireEvent.click(restore);
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.getByRole("combobox", { name: "Passing value" })).toHaveTextContent("True");
  choose("Factory", "Invoices · invoices-qa");
  expect(push).toHaveBeenCalledWith(`/w/acme/scorers?factory=${secondFactoryId}`, {
    scroll: false,
  });
});

it("reopens Advanced and keeps a custom identifier after a collision", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "Duplicate identifier.", code: "identifier_in_use" }, { status: 409 }),
    ),
  );
  render(
    <ScorerForm {...props} draft={{ kind: "create", preset: factoryScorerPresets.correctness }} />,
  );
  const advanced = screen.getByText("Advanced");
  fireEvent.click(advanced);
  const slug = screen.getByLabelText("Identifier");
  fireEvent.change(slug, { target: { value: "my-scorer" } });
  fireEvent.click(advanced);
  fireEvent.click(screen.getByRole("button", { name: "Publish scorer" }));
  await waitFor(() => expect(slug).toHaveFocus());
  expect(slug).toHaveValue("my-scorer");
  expect(slug).toHaveAccessibleDescription(/already in use/);
  expect(push).not.toHaveBeenCalled();
});
