import type { FactorySelectionOption } from "@/features/factories/factory-selection";

export function scorerFactoryLabel(
  factory: FactorySelectionOption,
  options: readonly FactorySelectionOption[],
) {
  return factory.slug &&
    options.some((option) => option.id !== factory.id && option.name === factory.name)
    ? `${factory.name} · ${factory.slug}`
    : factory.name;
}
