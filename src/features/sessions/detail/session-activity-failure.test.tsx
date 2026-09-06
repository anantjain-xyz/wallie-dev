// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { useTransition } from "react";
import { SessionRefreshContext } from "@/features/sessions/detail/session-refresh-context";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionActivityFailure } from "@/features/sessions/detail/session-activity-failure";

const mocked = vi.hoisted(() => ({ refresh: vi.fn() }));
function Harness() {
  const [pending, startTransition] = useTransition();
  return (
    <SessionRefreshContext.Provider
      value={{ pending, refresh: () => startTransition(() => mocked.refresh()) }}
    >
      <SessionActivityFailure />
    </SessionRefreshContext.Provider>
  );
}
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
    render(<Harness />);
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
