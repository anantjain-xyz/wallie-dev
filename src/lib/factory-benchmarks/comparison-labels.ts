const dateTime = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "UTC",
});

export const benchmarkReplayPolicyLabels = {
  blocked: "Blocked",
  recorded_fixtures: "Recorded fixtures",
  isolated_test: "Isolated test",
};

export function benchmarkPublicationTime(timestamp: string) {
  return `${dateTime.format(new Date(timestamp))} UTC`;
}

export function benchmarkScorerLabel(name: string, revisionNumber: number) {
  return `${name} · Revision ${revisionNumber}`;
}
