import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-registry.mjs policy|variables --account-id <12 digits> --region <region>";

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
    !["policy", "variables"].includes(command) ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    !/^\d{12}$/.test(accountId ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(region ?? "")
  ) {
    throw new Error(usage);
  }

  if (command === "variables") {
    console.log(JSON.stringify({ aws_account_id: accountId, aws_region: region }, null, 2));
    return;
  }
  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const template = readFileSync(
    new URL("../infra/aws/registry-policy.template.json", import.meta.url),
    "utf8",
  );
  console.log(
    JSON.stringify(
      JSON.parse(
        template
          .replaceAll("<ACCOUNT_ID>", accountId)
          .replaceAll("<REGION>", region)
          .replaceAll("<PARTITION>", partition),
      ),
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(`[aws-registry] ${error.message}`);
  process.exitCode = 1;
}
