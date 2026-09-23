import { readFileSync } from "node:fs";

const account = "111614490109";
const region = "us-west-2";
const secrets = {
  web: "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/web/runtime-vDeDr4",
  worker:
    "arn:aws:secretsmanager:us-west-2:111614490109:secret:/wallie/staging/worker/runtime-4C4k43",
};

try {
  if (process.argv.length !== 2) throw new Error("This renderer accepts no arguments");

  const policy = JSON.parse(
    readFileSync(new URL("../infra/aws/secrets-policy.template.json", import.meta.url), "utf8")
      .replaceAll("<ACCOUNT_ID>", account)
      .replaceAll("<REGION>", region),
  );
  for (const [component, arn] of Object.entries(secrets)) {
    const name = `/wallie/staging/${component}/runtime`;
    if (
      arn.match(
        /^arn:aws:secretsmanager:us-west-2:111614490109:secret:\/wallie\/staging\/(web|worker)\/runtime-[A-Za-z0-9]{6}$/,
      )?.[1] !== component
    )
      throw new Error("The exact deployed secret ARN did not match its component");
    policy.Statement.push({
      Sid: `TemporaryPut${component[0].toUpperCase()}${component.slice(1)}RuntimeValue`,
      Effect: "Allow",
      Action: "secretsmanager:PutSecretValue",
      Resource: arn,
      Condition: {
        StringEquals: {
          "aws:PrincipalAccount": account,
          "aws:RequestedRegion": region,
          "aws:ResourceTag/WallieStack": "wallie-staging-application",
          "aws:ResourceTag/Component": "runtime-secrets",
          "aws:ResourceTag/Name": name,
        },
      },
    });
  }

  if (JSON.stringify(policy).length > 6144)
    throw new Error("Rendered managed policy exceeds IAM's 6,144-character limit");
  console.log(JSON.stringify(policy, null, 2));
} catch (error) {
  console.error(`[aws-runtime-secret-write-grant] ${error.message}`);
  process.exitCode = 1;
}
