import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-image-signing.mjs policy|trust-policy --account-id <12 digits> --region <commercial or GovCloud region> --profile-version <10 alphanumeric characters>";

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
      "profile-version": { type: "string" },
    },
  });
  const accountId = values["account-id"];
  const region = values.region;
  const profileVersion = values["profile-version"];
  if (
    positionals.length !== 1 ||
    !["policy", "trust-policy"].includes(positionals[0]) ||
    tokens.filter((token) => token.kind === "option").length !== Object.keys(values).length ||
    Object.values(values).some((value) => value !== value.trim()) ||
    !/^\d{12}$/.test(accountId ?? "") ||
    !/^(?:[a-z]{2}-[a-z]+|us-gov-[a-z]+)-\d+$/.test(region ?? "") ||
    region.startsWith("cn-") ||
    !/^[a-zA-Z0-9]{10}$/.test(profileVersion ?? "")
  ) {
    throw new Error(usage);
  }

  const partition = region.startsWith("us-gov-") ? "aws-us-gov" : "aws";
  const trustStore = partition === "aws-us-gov" ? "aws-us-gov-signer-ts" : "aws-signer-ts";
  const templatePath =
    positionals[0] === "policy"
      ? "../infra/aws/image-signing-policy.template.json"
      : "../infra/aws/image-signing-trust-policy.template.json";
  const template = readFileSync(new URL(templatePath, import.meta.url), "utf8");
  console.log(
    JSON.stringify(
      JSON.parse(
        template
          .replaceAll("<ACCOUNT_ID>", accountId)
          .replaceAll("<REGION>", region)
          .replaceAll("<PARTITION>", partition)
          .replaceAll("<PROFILE_VERSION>", profileVersion)
          .replaceAll("<TRUST_STORE>", trustStore),
      ),
      null,
      2,
    ),
  );
}

try {
  main();
} catch (error) {
  console.error(`[aws-image-signing] ${error.message}`);
  process.exitCode = 1;
}
