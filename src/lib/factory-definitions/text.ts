export function isFactoryDefinitionText(value: string): boolean {
  // Unicode mode combines valid surrogate pairs before testing the category.
  return !/\p{Surrogate}/u.test(value) && !value.includes("\0");
}
