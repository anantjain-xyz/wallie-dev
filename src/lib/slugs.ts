export const addressSlugPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function slugifyAddress(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
