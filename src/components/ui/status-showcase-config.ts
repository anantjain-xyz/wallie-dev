export const STATUS_SIMULATIONS = [
  { label: "Standard color", value: "standard" },
  { label: "Forced colors preview", value: "forced-colors" },
  { label: "Protanopia", value: "protanopia" },
  { label: "Deuteranopia", value: "deuteranopia" },
  { label: "Tritanopia", value: "tritanopia" },
  { label: "Achromatopsia", value: "achromatopsia" },
] as const;

export type StatusSimulation = (typeof STATUS_SIMULATIONS)[number]["value"];

export function isStatusSimulation(value: string | undefined): value is StatusSimulation {
  return STATUS_SIMULATIONS.some((simulation) => simulation.value === value);
}
