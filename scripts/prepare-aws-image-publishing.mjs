import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-image-publishing.mjs policy --account-id <12 digits> --region <region>";

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
    },
  });
  const accountId = values["account-id"];
  const region = values.region;
  if (
    positionals.length !== 1 ||
    positionals[0] !== "policy" ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    !/^\d{12}$/.test(accountId ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(region ?? "")
  ) {
    throw new Error(usage);
  }

  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const template = readFileSync(
    new URL("../infra/aws/image-publishing-policy.template.json", import.meta.url),
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
  console.error(`[aws-image-publishing] ${error.message}`);
  process.exitCode = 1;
}
