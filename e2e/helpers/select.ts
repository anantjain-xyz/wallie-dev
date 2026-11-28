import { expect, type Locator, type Page } from "@playwright/test";

export function workspaceFactoryPicker(page: Page) {
  const header = page.getByRole("banner");
  const name = { name: "Factory", exact: true };
  return header.getByRole("combobox", name).or(header.getByRole("button", name));
}

export async function openWorkspaceFactoryPicker(page: Page) {
  await workspaceFactoryPicker(page).click();
  const name = { name: "Factory", exact: true };
  return page.getByRole("listbox", name).or(page.getByRole("menu", name));
}

export function workspaceFactoryChoices(popup: Locator, name?: string) {
  return popup
    .getByRole("option", { name, exact: true })
    .or(popup.getByRole("menuitemradio", { name, exact: true }));
}

export async function selectWorkspaceFactory(page: Page, choice: string | { label: string }) {
  const popup = await openWorkspaceFactoryPicker(page);
  if (typeof choice === "string") {
    await workspaceFactoryChoices(popup)
      .and(popup.locator(`[data-value=${JSON.stringify(choice)}]`))
      .click();
  } else {
    await workspaceFactoryChoices(popup, choice.label).click();
  }
}

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
