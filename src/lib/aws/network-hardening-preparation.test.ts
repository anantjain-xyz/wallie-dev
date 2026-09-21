import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-network-hardening.mjs", import.meta.url),
);
const inputs = {
  "account-id": "123456789012",
  region: "us-west-2",
  "vpc-id": "vpc-0123456789abcdef0",
  "default-security-group-id": "sg-0123456789abcdef0",
  "default-network-acl-id": "acl-0123456789abcdef0",
  "sandbox-subnet-a-id": "subnet-0123456789abcdef0",
  "sandbox-subnet-b-id": "subnet-0123456789abcdef1",
};
const argsFor = (values: Record<string, string>) =>
  Object.entries(values).flatMap(([key, value]) => [`--${key}`, value]);
const args = argsFor(inputs);
const array = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
type Statement = {
  Action: string | string[];
  Resource: string | string[];
  Condition: Record<string, Record<string, string | string[]>>;
};

function render(parameters = args) {
  return spawnSync(process.execPath, [script, ...parameters], {
    encoding: "utf8",
    timeout: 5_000,
    env: { NODE_ENV: "test", PATH: "" },
  });
}

describe("AWS network hardening policy preparation", () => {
  it.each([
    ["us-west-2", "aws"],
    ["us-gov-west-1", "aws-us-gov"],
    ["cn-north-1", "aws-cn"],
  ])("renders offline with exact resource IDs in %s", (region, partition) => {
    const result = render(argsFor({ ...inputs, region }));
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toMatch(/<[A-Z_]+>|access_key|secret_key|token|profile/);
    const policy = JSON.parse(result.stdout);
    expect(policy.Version).toBe("2012-10-17");
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6_144);
    for (const id of Object.values(inputs).slice(2)) expect(result.stdout).toContain(id);
    for (const statement of policy.Statement as Statement[]) {
      expect(statement.Condition.StringEquals).toMatchObject({
        "aws:PrincipalAccount": inputs["account-id"],
        "aws:RequestedRegion": region,
      });
      for (const action of array(statement.Action)) {
        expect(action).toMatch(/^ec2:[A-Za-z]+$/);
        expect(action).not.toMatch(
          /AuthorizeSecurityGroup|CreateSecurityGroup|CreateNetworkAclEntry|ReplaceNetworkAclEntry|RunInstances/,
        );
      }
      for (const resource of array(statement.Resource)) {
        if (resource === "*") {
          expect(array(statement.Action).every((action) => action.startsWith("ec2:Describe"))).toBe(
            true,
          );
        } else {
          expect(resource).toMatch(
            new RegExp(`^arn:${partition}:ec2:${region}:${inputs["account-id"]}:`),
          );
          if (resource.includes("*")) expect(resource.endsWith(":network-acl/*")).toBe(true);
        }
      }
    }
  });

  it.each(Object.keys(inputs))("requires %s", (key) => {
    const values = { ...inputs } as Record<string, string>;
    delete values[key];
    const result = render(argsFor(values));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["account-id", "123"],
    ["region", "us-iso-east-1"],
    ["region", 'us-west-2"\nprofile="root'],
    ["vpc-id", "vpc-*"],
    ["default-security-group-id", "sg-xyz"],
    ["default-network-acl-id", "acl-123"],
    ["sandbox-subnet-a-id", "vpc-0123456789abcdef0"],
    ["sandbox-subnet-b-id", inputs["sandbox-subnet-a-id"]],
  ])("rejects invalid or ambiguous %s", (key, value) => {
    const result = render(argsFor({ ...inputs, [key]: value }));
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("[aws-network-hardening]");
  });

  it.each([["--vpc-id", inputs["vpc-id"]], ["--profile", "root"], ["apply"]])(
    "rejects extra or repeated arguments %j",
    (...extra) => {
      const result = render([...args, ...extra]);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
    },
  );
});

// Structural regression guards, not an AWS authorization simulator.
describe("hardening permission boundaries", () => {
  const vpcArn = `arn:aws:ec2:${inputs.region}:${inputs["account-id"]}:vpc/${inputs["vpc-id"]}`;
  const sgArn = `arn:aws:ec2:${inputs.region}:${inputs["account-id"]}:security-group/${inputs["default-security-group-id"]}`;
  const markers = {
    "aws:ResourceTag/WallieStack": "wallie-staging-network",
    "aws:ResourceTag/Component": "hardening",
  };
  function grants() {
    const result = render();
    expect(result.status).toBe(0);
    return JSON.parse(result.stdout).Statement as Statement[];
  }

  it("limits default-group rule removal and metadata deletion to the exact group", () => {
    const matching = grants().filter((s) =>
      array(s.Action).some(
        (action) => action.startsWith("ec2:RevokeSecurityGroup") || action === "ec2:DeleteTags",
      ),
    );
    expect(matching.length).toBeGreaterThan(0);
    for (const statement of matching) expect(array(statement.Resource)).toEqual([sgArn]);
    const deletion = matching.find((s) => array(s.Action).includes("ec2:DeleteTags"))!;
    expect(deletion.Condition.Null["aws:TagKeys"]).toBe("false");
    expect(deletion.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).not.toContain(
      "WallieStack",
    );
    expect(deletion.Condition["ForAllValues:StringEquals"]["aws:TagKeys"]).not.toContain(
      "Component",
    );
  });

  it("requires exact parent authorization and prevents adopting an unrelated ACL by tagging", () => {
    const statements = grants();
    const parent = statements.filter(
      (s) =>
        array(s.Action).includes("ec2:CreateNetworkAcl") &&
        array(s.Resource).some((r) => r.includes(":vpc/")),
    );
    expect(parent).toHaveLength(1);
    expect(array(parent[0].Resource)).toEqual([vpcArn]);
    expect(parent[0].Condition.StringEquals["aws:ResourceTag/WallieStack"]).toBe(
      "wallie-staging-network",
    );
    for (const statement of statements.filter(
      (s) =>
        array(s.Action).includes("ec2:CreateTags") &&
        array(s.Resource).some((r) => r.endsWith(":network-acl/*")),
    )) {
      const condition = statement.Condition;
      if (condition.StringEquals["ec2:CreateAction"]) {
        expect(condition.StringEquals["ec2:CreateAction"]).toBe("CreateNetworkAcl");
        expect(condition.StringEquals["aws:RequestTag/WallieStack"]).toBe("wallie-staging-network");
        expect(condition.StringEquals["aws:RequestTag/Component"]).toBe("hardening");
      } else {
        expect(condition.StringEquals).toMatchObject(markers);
        expect(condition.ArnEquals["ec2:Vpc"]).toBe(vpcArn);
        expect(condition.StringEqualsIfExists).toMatchObject({
          "aws:RequestTag/WallieStack": "wallie-staging-network",
          "aws:RequestTag/Component": "hardening",
        });
      }
    }
  });

  it("restricts custom ACL mutations to owned ACLs in the selected VPC and associations to the sandbox pair", () => {
    const statements = grants();
    const resources = statements
      .filter((s) => array(s.Action).includes("ec2:ReplaceNetworkAclAssociation"))
      .flatMap((s) => array(s.Resource));
    expect(resources.filter((r) => r.includes(":subnet/")).sort()).toEqual(
      [inputs["sandbox-subnet-a-id"], inputs["sandbox-subnet-b-id"]]
        .map((id) => `arn:aws:ec2:${inputs.region}:${inputs["account-id"]}:subnet/${id}`)
        .sort(),
    );
    expect(resources.filter((r) => r.includes(":network-acl/") && !r.includes("*"))).toEqual([
      `arn:aws:ec2:${inputs.region}:${inputs["account-id"]}:network-acl/${inputs["default-network-acl-id"]}`,
    ]);
    for (const statement of statements.filter((s) =>
      array(s.Action).some((action) =>
        [
          "ec2:DeleteNetworkAcl",
          "ec2:DeleteNetworkAclEntry",
          "ec2:ReplaceNetworkAclAssociation",
        ].includes(action),
      ),
    )) {
      expect(statement.Condition.ArnEquals["ec2:Vpc"]).toBe(vpcArn);
      if (array(statement.Resource).some((r) => r.endsWith(":network-acl/*"))) {
        expect(statement.Condition.StringEquals).toMatchObject(markers);
      }
    }
  });
});
