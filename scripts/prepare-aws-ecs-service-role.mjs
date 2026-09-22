import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-ecs-service-role.mjs policy --account-id <12 digits>";

try {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: { "account-id": { type: "string" } },
  });
  const account = values["account-id"];
  if (
    positionals.length !== 1 ||
    positionals[0] !== "policy" ||
    tokens.filter((token) => token.kind === "option").length !== 1 ||
    typeof account !== "string" ||
    account.length !== 12 ||
    !/^\d{12}$/.test(account)
  )
    throw new Error(usage);

  const policy = JSON.parse(
    readFileSync(
      new URL("../infra/aws/ecs-service-role-bootstrap-policy.template.json", import.meta.url),
      "utf8",
    ).replaceAll("<ACCOUNT_ID>", account),
  );
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-ecs-service-role] ${error.message}`);
  process.exitCode = 1;
}
