// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";

import type { FactoryAutomationDefinition } from "@/lib/factory-automations/contracts";

import { AutomationEditorFields, readAutomationDraft } from "./automation-editor-fields";

const initial: FactoryAutomationDefinition = {
  name: "Schedule fixture",
  trigger: { kind: "schedule", cron: "0 9 * * *", timeZone: "Etc/UTC" },
  filters: {},
  target: {
    kind: "agent",
    definitionRevisionId: "66410000-0000-4000-8000-000000000001",
    agentId: "66410000-0000-4000-8000-000000000002",
  },
  executionGrant: { id: "66410000-0000-4000-8000-000000000003", version: 1 },
  servicePrincipalId: "66410000-0000-4000-8000-000000000004",
  budgetPayerMemberId: "66410000-0000-4000-8000-000000000005",
  credentialBindingId: "66410000-0000-4000-8000-000000000006",
};

afterEach(cleanup);

it("serializes suggested and unlisted time zones from the same required field", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Schedule fixture">
      <AutomationEditorFields initial={initial} setup={null} disabled={false} changed={() => {}} />
    </form>,
  );

  const form = screen.getByRole("form", { name: "Schedule fixture" });
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing schedule form");
  const timeZone = screen.getByRole("combobox", { name: "Time zone" });
  expect(timeZone).toHaveAttribute("name", "timeZone");
  expect(timeZone).toHaveAttribute("maxlength", "80");
  expect(timeZone).toBeRequired();
  expect(timeZone).toHaveValue("Etc/UTC");

  await user.click(timeZone);
  expect(screen.getByRole("listbox", { name: "Time zone suggestions" })).toBeVisible();
  expect(screen.getAllByRole("option")).toHaveLength(8);
  expect(screen.getByRole("option", { name: "Etc/UTC", selected: true })).toBeVisible();

  await user.clear(timeZone);
  await user.type(timeZone, "london");
  expect(screen.getAllByRole("option")).toEqual([
    screen.getByRole("option", { name: "Europe/London" }),
  ]);
  await user.keyboard("{ArrowDown}{Enter}");
  expect(timeZone).toHaveFocus();
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(new FormData(form).getAll("timeZone")).toEqual(["Europe/London"]);

  await user.clear(timeZone);
  await user.type(timeZone, "Pacific/Chatham");
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  expect(readAutomationDraft(form, null, initial)).toMatchObject({
    success: true,
    data: { trigger: { kind: "schedule", cron: "0 9 * * *", timeZone: "Pacific/Chatham" } },
  });
});

it("retains local time and custom cron while serializing the visible schedule preset", async () => {
  const user = userEvent.setup();
  render(
    <form aria-label="Schedule fixture">
      <AutomationEditorFields initial={initial} setup={null} disabled={false} changed={() => {}} />
    </form>,
  );

  const form = screen.getByRole("form", { name: "Schedule fixture" });
  if (!(form instanceof HTMLFormElement)) throw new Error("Missing schedule form");

  async function chooseCadence(label: string) {
    await user.click(screen.getByRole("combobox", { name: "Schedule" }));
    await user.click(screen.getByRole("option", { name: label }));
  }

  const expectCron = (cron: string) => {
    expect(readAutomationDraft(form, null, initial)).toMatchObject({
      success: true,
      data: { trigger: { kind: "schedule", cron, timeZone: "Etc/UTC" } },
    });
  };

  fireEvent.change(screen.getByLabelText("Local time"), { target: { value: "07:45" } });
  await chooseCadence("Every hour");
  expect(screen.queryByLabelText("Local time")).not.toBeInTheDocument();
  expectCron("0 * * * *");

  await chooseCadence("Weekdays");
  expect(screen.getByLabelText("Local time")).toHaveValue("07:45");
  expectCron("45 7 * * 1-5");

  await chooseCadence("Custom cron");
  fireEvent.change(screen.getByLabelText(/^Cron expression/), {
    target: { value: "15 16 * * 2,4" },
  });
  await chooseCadence("Every day");
  expect(screen.getByLabelText("Local time")).toHaveValue("07:45");

  await chooseCadence("Custom cron");
  expect(screen.getByLabelText(/^Cron expression/)).toHaveValue("15 16 * * 2,4");
  expectCron("15 16 * * 2,4");
});
