export const slackAppEnvKeys = [
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;

export function getMissingSlackEnvKeys(
  keys: readonly string[],
  input: Record<string, string | undefined> = process.env,
) {
  return keys.filter((key) => !input[key]?.trim());
}

export function getSlackConfigStatus(input: Record<string, string | undefined> = process.env) {
  return {
    missingAppKeys: getMissingSlackEnvKeys(slackAppEnvKeys, input),
  };
}
