// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { EmailCodeInputs } from "./email-code-inputs";

afterEach(cleanup);

it.each(["typing", "paste"])(
  "allows explicit submit only after completing the code by %s",
  (method) => {
    const submitted = vi.fn();
    render(
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submitted(new FormData(event.currentTarget).getAll("tokenDigit").join(""));
        }}
      >
        <EmailCodeInputs />
        <button type="submit">Continue with code</button>
      </form>,
    );
    const digits = screen.getAllByRole<HTMLInputElement>("textbox");
    if (method === "paste") {
      fireEvent.paste(digits[2], { clipboardData: { getData: () => "123-456" } });
    } else {
      digits.forEach((digit, index) =>
        fireEvent.change(digit, { target: { value: String(index + 1) } }),
      );
    }
    expect(digits.map(({ value }) => value).join("")).toBe("123456");
    expect(submitted).not.toHaveBeenCalled();
    fireEvent.change(digits[5], { target: { value: "7" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue with code" }));
    expect(submitted).toHaveBeenCalledExactlyOnceWith("123457");
  },
);
