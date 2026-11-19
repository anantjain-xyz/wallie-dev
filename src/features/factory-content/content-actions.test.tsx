// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { MemoryRevisionActions } from "./content-actions";

const mocks = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));

const scope = {
  workspaceId: "58200000-0000-4000-8000-000000000001",
  factoryId: "58200000-0000-4000-8000-000000000002",
  workspaceSlug: "atlas",
};
const memory = {
  id: "58200000-0000-4000-8000-000000000003",
  current_revision_id: "58200000-0000-4000-8000-000000000004",
  pending_revision_id: null,
};
const expiresAt = "2032-04-15T18:28:37.123456+03:00";
const correction = {
  action: "correct",
  memoryId: memory.id,
  expectedCurrentRevisionId: memory.current_revision_id,
  expectedPendingRevisionId: null,
  body: "Use the corrected checklist.",
};

function renderCorrection(expiry: string | null) {
  const requests: unknown[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_path, request: RequestInit) => {
      requests.push(JSON.parse(String(request.body)));
      return Response.json({ memory: { id: memory.id } });
    }),
  );
  render(
    <MemoryRevisionActions
      scope={scope}
      memory={memory}
      body="Original checklist"
      expiresAt={expiry}
      canReview={false}
    />,
  );
  const field = screen.getByLabelText<HTMLInputElement>("Expiry in your local time");
  async function correctNote() {
    fireEvent.change(screen.getByLabelText("Memory note"), { target: { value: correction.body } });
    fireEvent.click(screen.getByRole("button", { name: "Save pending revision" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce());
  }
  return { field, requests, correctNote };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  mocks.refresh.mockClear();
});

describe("memory correction expiry", () => {
  it("shows the current expiry in browser local time and preserves the exact original instant on a note-only edit", async () => {
    const { field, requests, correctNote } = renderCorrection(expiresAt);
    expect(field.value).toMatch(/^2032-04-15T\d{2}:28$/);
    // The minute-resolution display refers to the original instant in the current zone.
    expect(new Date(field.value).getTime()).toBe(
      Math.floor(Date.parse(expiresAt) / 60_000) * 60_000,
    );
    await correctNote();
    expect(requests).toEqual([{ ...correction, expiresAt }]);
  });

  it("clears the expiry when the manager explicitly blanks the prefilled field", async () => {
    const { field, requests, correctNote } = renderCorrection(expiresAt);
    expect(field.value).not.toBe("");
    fireEvent.change(field, { target: { value: "" } });
    await correctNote();
    expect(requests).toEqual([correction]);
  });

  it("leaves a note with no expiry unbounded", async () => {
    const { field, requests, correctNote } = renderCorrection(null);
    expect(field.value).toBe("");
    await correctNote();
    expect(requests).toEqual([correction]);
  });
});
