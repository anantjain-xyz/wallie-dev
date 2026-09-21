import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-state.mjs bootstrap-policy|access-policy|backend --account-id <12 digits> --region <region>";

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
    },
  });
  const [command] = positionals;
  const accountId = values["account-id"];
  const region = values.region;
  if (
    positionals.length !== 1 ||
    !["bootstrap-policy", "access-policy", "backend"].includes(command) ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    !/^\d{12}$/.test(accountId ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(region ?? "")
  ) {
    throw new Error(usage);
  }

  const bucket = `wallie-staging-tfstate-${accountId}-${region}`;
  if (command === "backend") {
    console.log(
      [
        `bucket              = "${bucket}"`,
        `region              = "${region}"`,
        'key                 = "staging/foundation.tfstate"',
        "encrypt             = true",
        "use_lockfile        = true",
        `allowed_account_ids = ["${accountId}"]`,
      ].join("\n"),
    );
    return;
  }

  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const template = readFileSync(
    new URL(`../infra/aws/state-${command}.template.json`, import.meta.url),
    "utf8",
  );
  const policy = JSON.parse(
    template
      .replaceAll("<ACCOUNT_ID>", accountId)
      .replaceAll("<REGION>", region)
      .replaceAll("<PARTITION>", partition)
      .replaceAll("<BUCKET_NAME>", bucket)
      .replaceAll("<STACK_NAME>", "wallie-staging-state"),
  );
  console.log(JSON.stringify(policy, null, 2));
}

try {
  main();
} catch (error) {
  console.error(`[aws-state] ${error.message}`);
  process.exitCode = 1;
}
