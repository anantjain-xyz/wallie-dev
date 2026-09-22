import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-application.mjs policy|variables --account-id <12 digits> --region <commercial AWS region>";

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
    },
  });
  const [command] = positionals;
  const account = values["account-id"];
  const region = values.region;
  if (
    positionals.length !== 1 ||
    !["policy", "variables"].includes(command) ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim()) ||
    !/^\d{12}$/.test(account ?? "") ||
    !/^[a-z]{2}-[a-z]+-\d+$/.test(region ?? "") ||
    region.startsWith("cn-")
  )
    throw new Error(usage);

  const result =
    command === "variables"
      ? { aws_account_id: account, aws_region: region }
      : JSON.parse(
          readFileSync(
            new URL("../infra/aws/application-policy.template.json", import.meta.url),
            "utf8",
          )
            .replaceAll("<ACCOUNT_ID>", account)
            .replaceAll("<REGION>", region),
        );
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(`[aws-application] ${error.message}`);
  process.exitCode = 1;
}
