// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";

import { ConsentForm } from "./consent-form";

afterEach(cleanup);

function renderForm() {
  const submissions: string[] = [];
  const { container } = render(
    <ConsentForm authorizationId="authorization">
      <label>
        <input name="factoryIds" type="checkbox" value="demo" />
        Demo factory
      </label>
    </ConsentForm>,
  );
  container.addEventListener("submit", (event) => {
    if (!event.defaultPrevented)
      submissions.push((event as SubmitEvent).submitter!.getAttribute("value")!);
    event.preventDefault();
  });
  return submissions;
}

it("blocks empty Allow in place and leaves Deny available with pending feedback", () => {
  const submissions = renderForm();
  fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
  const error = screen.getByRole("alert");
  expect(error.textContent).toBe("Select at least one factory to allow access.");
  expect(document.activeElement).toBe(error);
  expect(submissions).toEqual([]);

  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("status").textContent).toBe("Denying access…");
  expect(submissions).toEqual(["deny"]);
});

it("clears the selection prompt, submits once, and announces Allow separately", () => {
  const submissions = renderForm();
  fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Demo factory" }));
  expect(screen.queryByRole("alert")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Allow access" }));
  expect(screen.getByRole("status").textContent).toBe("Allowing access…");
  fireEvent.click(screen.getByRole("button", { name: "Deny" }));
  expect(submissions).toEqual(["allow"]);
});
