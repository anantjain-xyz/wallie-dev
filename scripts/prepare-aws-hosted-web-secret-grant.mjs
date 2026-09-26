import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const account = "111614490109";
const region = "us-west-2";
const arn =
  "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4";

export function hostedWebSecretGrant(expiresAt, now = Date.now()) {
  const deadline = Date.parse(expiresAt);
  if (
    typeof expiresAt !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(expiresAt) ||
    !Number.isFinite(deadline) ||
    deadline <= now + 5 * 60_000 ||
    deadline > now + 24 * 60 * 60_000
  )
    throw new Error("Expected an expiry five minutes to 24 hours ahead in whole-second UTC");

  const condition = {
    StringEquals: {
      "aws:PrincipalAccount": account,
      "aws:RequestedRegion": region,
      "aws:ResourceTag/WallieStack": "wallie-staging-application",
      "aws:ResourceTag/Component": "runtime-secrets",
      "aws:ResourceTag/Name": "/wallie/staging/web/runtime",
    },
    DateLessThan: { "aws:CurrentTime": expiresAt },
  };
  const policy = {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "ReadExactHostedWebRuntimeMetadata",
        Effect: "Allow",
        Action: [
          "secretsmanager:DescribeSecret",
          "secretsmanager:GetResourcePolicy",
          "secretsmanager:ListSecretVersionIds",
        ],
        Resource: arn,
        Condition: condition,
      },
      {
        Sid: "PutExactHostedWebRuntimeValue",
        Effect: "Allow",
        Action: "secretsmanager:PutSecretValue",
        Resource: arn,
        Condition: condition,
      },
    ],
  };
  if (JSON.stringify(policy).length > 6144)
    throw new Error("Rendered policy exceeds IAM's 6,144-character limit");
  return policy;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { values, positionals, tokens } = parseArgs({
      allowPositionals: true,
      tokens: true,
      options: { "expires-at": { type: "string" } },
    });
    if (positionals.length !== 0 || tokens.length !== 1 || Object.keys(values).length !== 1)
      throw new Error("Expected exactly --expires-at <UTC timestamp>");
    console.log(JSON.stringify(hostedWebSecretGrant(values["expires-at"]), null, 2));
  } catch (error) {
    console.error(`[aws-hosted-web-secret-grant] ${error.message}`);
    process.exitCode = 1;
  }
}
