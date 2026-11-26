// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { expect, it, vi } from "vitest";

import { EditableCombobox } from "@/components/ui/editable-combobox";

it("lets a named field choose suggestions or submit other text without changing its form contract", async () => {
  const user = userEvent.setup();
  const submit = vi.fn();

  function TimeZoneForm() {
    const [value, setValue] = useState("");
    const options = [{ label: "UTC", value: "Etc/UTC" }].filter((option) =>
      option.value.toLowerCase().includes(value.toLowerCase()),
    );
    return (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          submit(new FormData(event.currentTarget).get("timeZone"));
        }}
      >
        <label>
          Time zone
          <EditableCombobox
            listboxLabel="Time zone suggestions"
            maxLength={80}
            name="timeZone"
            onValueChange={setValue}
            options={options}
            required
            value={value}
          />
        </label>
        <button type="submit">Save</button>
      </form>
    );
  }

  render(<TimeZoneForm />);
  const input = screen.getByRole("combobox", { name: "Time zone" });
  expect(input).toBeRequired();
  expect(input).toHaveAttribute("maxlength", "80");
  await user.click(input);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(input).toHaveValue("Etc/UTC");
  expect(input).toHaveFocus();
  expect(submit).not.toHaveBeenCalled();

  await user.clear(input);
  await user.type(input, "Pacific/Chatham");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  await user.keyboard("{Enter}");
  expect(submit).toHaveBeenCalledWith("Pacific/Chatham");
});
