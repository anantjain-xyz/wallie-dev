// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActivityFailure } from "@/features/sessions/detail/session-activity-failure";

const mocked = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocked.refresh }) }));
afterEach(() => {
  cleanup();
  mocked.refresh.mockReset();
});

describe("SessionActivityFailure", () => {
  it("keeps retry feedback visible and prevents duplicate requests until refresh completes", async () => {
    let finish!: () => void;
    mocked.refresh.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<SessionActivityFailure />);
    fireEvent.click(screen.getByRole("button", { name: "Retry loading history" }));
    const pending = screen.getByRole("button", { name: "Loading history…" });
    expect(pending).toBeDisabled();
    fireEvent.click(pending);
    expect(mocked.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Run activity is temporarily unavailable.",
    );
    await act(async () => finish());
    expect(screen.getByRole("button", { name: "Retry loading history" })).toBeEnabled();
  });
});
