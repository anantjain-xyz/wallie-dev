// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { PortalRootProvider } from "@/components/ui/portal-root";
import { FactoryRevisionHistory } from "@/features/factory-definition/revision-history";
import type {
  FactoryEditorActivation,
  FactoryEditorDocument,
} from "@/lib/factory-definitions/editor-contracts";
import { factoryDefinitionFromBundle } from "@/lib/factory-definitions/stored-definition";

const currentId = "58eac8d9-79f8-4a97-9d45-5d4b988f6bad";
const olderId = "fc38cd1e-d940-4310-8d13-967bb38a5766";
const sourceDraftId = "114aad62-30b7-4206-bcd5-06ee5c811fb5";
const createdAt = "2026-11-15T20:00:00Z";
const activations: FactoryEditorActivation[] = [
  {
    id: "9cc29de0-81c3-46d4-a9a1-9346eb6d67a6",
    revisionId: currentId,
    activationNumber: 2,
    previousActivationNumber: 1,
    createdAt,
  },
  {
    id: "99fd11ae-f549-4eb8-9b27-e194898f5018",
    revisionId: olderId,
    activationNumber: 1,
    previousActivationNumber: null,
    createdAt,
  },
];

const bundle: FactoryEditorDocument["bundle"] = {
  schemaVersion: 1,
  kind: "serial",
  pipelineId: "6800a051-85ff-4257-a177-4f147a2dccf9",
  repositoryId: "2f78b316-cab7-4b07-8b54-7cbe17a16af3",
  sandboxProvider: "vercel",
  agent: {
    provider: "codex",
    model: "gpt-5.5",
    effort: null,
    concurrencyLimit: 1,
    stallTimeoutMs: 900_000,
    maxRetries: 2,
    maxTurns: 50,
  },
  executionPolicyRevisionId: null,
  deliveryPolicyRevisionId: null,
  skillIds: [],
  toolIds: [],
  operatingRulesMd: "",
  operatingRuleStageIds: [],
  stages: [
    {
      id: "3f1bbc80-e239-45b6-b3fc-8f338a7837fe",
      name: "Plan",
      slug: "plan",
      description: "",
      promptTemplateMd: "Plan the change.",
      anyoneCanApprove: false,
      approverMemberIds: [],
      previousStageIds: [],
    },
  ],
};

const savedRevision: FactoryEditorDocument = {
  id: olderId,
  kind: "revision",
  digest: "d".repeat(64),
  createdAt,
  sourceDraftId,
  bundle,
  source: factoryDefinitionFromBundle(bundle),
};

const baseProps = {
  activations,
  activeActivationNumber: 2,
  activeRevisionId: currentId,
  selectedRevisionId: olderId,
  selectedDocument: savedRevision,
  nextBeforeActivationNumber: null,
  busy: false,
  canManage: true,
  onSelect: () => undefined,
  onLoadMore: () => undefined,
  revisionHref: (id: string) => `/w/demo/settings/factory-definition?revision=${id}`,
  sourceDraftHref: (id: string) => `/w/demo/settings/factory-definition?draft=${id}`,
};

afterEach(cleanup);

it("links selected immutable source and confirms the revision against the displayed activation", async () => {
  const onRollback = vi.fn(async () => undefined);
  const { rerender } = render(<FactoryRevisionHistory {...baseProps} onRollback={onRollback} />, {
    wrapper: PortalRootProvider,
  });

  expect(screen.getByRole("button", { name: /Activation #1/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect(screen.getByText(savedRevision.digest)).toBeVisible();
  expect(screen.getByRole("link", { name: /Open source draft/ })).toHaveAttribute(
    "href",
    baseProps.sourceDraftHref(sourceDraftId),
  );
  expect(screen.getByRole("link", { name: /Revision permalink/ })).toHaveAttribute(
    "target",
    "_blank",
  );

  fireEvent.click(screen.getByRole("button", { name: "Roll back to this revision" }));
  const dialog = await screen.findByRole("alertdialog", { name: "Activate this revision?" });
  expect(within(dialog).getByText("Current activation")).toBeVisible();
  expect(within(dialog).getByText("#2")).toBeVisible();
  expect(within(dialog).getByText("Selected revision digest")).toBeVisible();
  expect(within(dialog).getByText(savedRevision.digest)).toBeVisible();
  expect(onRollback).toHaveBeenCalledTimes(0);

  const newSelection = { ...savedRevision, id: currentId, digest: "e".repeat(64) };
  rerender(
    <FactoryRevisionHistory
      {...baseProps}
      activeActivationNumber={3}
      activeRevisionId="5bd1bb28-7745-4e7a-a1ff-f87ef2226793"
      onRollback={onRollback}
      selectedDocument={newSelection}
      selectedRevisionId={newSelection.id}
    />,
  );
  expect(within(dialog).getByText("#2")).toBeVisible();
  expect(within(dialog).getByText(savedRevision.digest)).toBeVisible();
  fireEvent.click(within(dialog).getByRole("button", { name: "Activate revision" }));
  await waitFor(() => expect(onRollback).toHaveBeenCalledWith(olderId, 2));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
});

it("keeps rollback errors in the confirmation dialog", async () => {
  const onRollback = vi.fn(async () => {
    throw new Error("The factory configuration changed. Reload before retrying.");
  });
  render(<FactoryRevisionHistory {...baseProps} onRollback={onRollback} />, {
    wrapper: PortalRootProvider,
  });

  fireEvent.click(screen.getByRole("button", { name: "Roll back to this revision" }));
  fireEvent.click(await screen.findByRole("button", { name: "Activate revision" }));

  expect(await screen.findByRole("alert")).toHaveTextContent("Reload before retrying.");
  expect(screen.getByRole("alertdialog")).toBeVisible();
});
