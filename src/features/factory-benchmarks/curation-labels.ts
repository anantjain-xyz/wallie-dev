export function benchmarkPurposeLabel(purpose: string) {
  return purpose === "holdout" ? "Holdout" : "Regression";
}

export function benchmarkEligibilityLabel(eligibility: string) {
  switch (eligibility) {
    case "eligible":
      return "Eligible for replay";
    case "ineligible":
      return "Ineligible for replay";
    default:
      return "Replay eligibility unverified";
  }
}

export function readBenchmarkTags(value: FormDataEntryValue | null) {
  return typeof value === "string"
    ? value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean)
    : [];
}
