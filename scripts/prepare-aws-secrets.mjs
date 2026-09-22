import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-secrets.mjs --account-id <12 digits> --region <commercial AWS region>";

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
    },
  });
  const account = values["account-id"];
  const region = values.region;
  if (
    positionals.length !== 0 ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim()) ||
    !/^\d{12}$/.test(account ?? "") ||
    !/^[a-z]{2}-[a-z]+-\d+$/.test(region ?? "") ||
    region.startsWith("cn-")
  )
    throw new Error(usage);

  const policy = JSON.parse(
    readFileSync(new URL("../infra/aws/secrets-policy.template.json", import.meta.url), "utf8")
      .replaceAll("<ACCOUNT_ID>", account)
      .replaceAll("<REGION>", region),
  );
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-secrets] ${error.message}`);
  process.exitCode = 1;
}
