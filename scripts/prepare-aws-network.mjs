import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const usage =
  "Usage: node scripts/prepare-aws-network.mjs policy|variables --account-id <12 digits> --region <region> [--availability-zones <zone-a,zone-b>] [--cidr <private /16>]";

function main() {
  const { values, positionals, tokens } = parseArgs({
    allowPositionals: true,
    tokens: true,
    options: {
      "account-id": { type: "string" },
      region: { type: "string" },
      "availability-zones": { type: "string" },
      cidr: { type: "string" },
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
    const zones = values["availability-zones"]?.split(",") ?? [];
    const cidr = values.cidr ?? "10.42.0.0/16";
    const octets = cidr
      .match(/^(\d{1,3})\.(\d{1,3})\.0\.0\/16$/)
      ?.slice(1)
      .map(Number);
    if (
      zones.length !== 2 ||
      new Set(zones).size !== 2 ||
      !zones.every((zone) => new RegExp(`^${region}[a-z]$`).test(zone)) ||
      !octets ||
      `${octets[0]}.${octets[1]}.0.0/16` !== cidr ||
      !(
        (octets[0] === 10 && octets[1] <= 255) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
        (octets[0] === 192 && octets[1] === 168)
      )
    ) {
      throw new Error("Variables require two distinct regional AZs and an aligned private /16.");
    }
    console.log(
      JSON.stringify(
        {
          aws_account_id: accountId,
          aws_region: region,
          availability_zones: zones,
          vpc_cidr: cidr,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (values["availability-zones"] !== undefined || values.cidr !== undefined)
    throw new Error(usage);
  const partition = region.startsWith("cn-")
    ? "aws-cn"
    : region.startsWith("us-gov-")
      ? "aws-us-gov"
      : "aws";
  const template = readFileSync(
    new URL("../infra/aws/network-policy.template.json", import.meta.url),
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
  console.error(`[aws-network] ${error.message}`);
  process.exitCode = 1;
}
