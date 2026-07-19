// @vitest-environment jsdom

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useApiAction } from "@/features/settings/use-api-action";

describe("useApiAction", () => {
  it("uses the shared state contract and closes the same-frame double-submit gap", async () => {
    let release!: () => void;
    const call = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(Response.json({ ok: true }));
        }),
    );
    const setFlashMessage = vi.fn();

    function Harness() {
      const action = useApiAction<{ ok: true }>({
        call,
        errorText: "Save failed.",
        setFlashMessage,
        successText: "Saved.",
      });
      return (
        <>
          <button onClick={() => void action.run()} type="button">
            Save
          </button>
          <output>{action.feedback.status}</output>
        </>
      );
    }

    render(<Harness />);
    const save = screen.getByRole("button", { name: "Save" });
    fireEvent.click(save);
    fireEvent.click(save);

    expect(call).toHaveBeenCalledTimes(1);
    expect(screen.getByText("pending")).toBeTruthy();

    await act(async () => release());
    await waitFor(() => expect(screen.getByText("success")).toBeTruthy());
    expect(setFlashMessage).toHaveBeenCalledWith({ kind: "success", text: "Saved." });
  });
});
