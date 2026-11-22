import { expect, type Locator } from "@playwright/test";

export async function openDropdownListbox(combobox: Locator) {
  await combobox.click();
  const listboxId = await combobox.getAttribute("aria-controls");
  const page = combobox.page();
  return listboxId ? page.locator(`[id=${JSON.stringify(listboxId)}]`) : page.getByRole("listbox");
}

export async function selectDropdownOption(combobox: Locator, choice: string | { label: string }) {
  const listbox = await openDropdownListbox(combobox);
  if (typeof choice === "string") {
    await listbox.locator(`[role="option"][data-value=${JSON.stringify(choice)}]`).click();
    return;
  }
  await listbox.getByRole("option", { name: choice.label, exact: true }).click();
}

export async function expectDropdownValue(
  combobox: Locator,
  value: string,
  options?: { timeout?: number },
) {
  await expect(combobox).toHaveAttribute("data-value", value, options);
}
