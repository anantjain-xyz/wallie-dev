import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../../../scripts/prepare-aws-visible-web-grant.mjs", import.meta.url),
);
const { visibleWebGrant } = await import(new URL(`file://${script}`).href);
const now = Date.parse("2026-09-26T20:00:00Z");
const config = {
  account: "111614490109",
  region: "us-west-2",
  expiresAt: "2026-09-26T22:00:00Z",
};

describe("visible staging web deployment grants", () => {
  it("scopes tagged security-group-rule creation and grants no DNS write", () => {
    const policy = visibleWebGrant("infrastructure", config, now);
    const createRule = policy.Statement.find(
      (item: { Sid: string }) => item.Sid === "CreateSGRule",
    );
    expect(createRule.Resource).toBe("arn:aws:ec2:us-west-2:111614490109:security-group-rule/*");
    expect(createRule.Condition.StringEquals["aws:RequestTag/WallieStack"]).toBe(
      "wallie-staging-application",
    );
    expect(createRule.Condition.StringEquals["aws:RequestTag/Name"]).toEqual([
      "wallie-staging-web-alb-https",
      "wallie-staging-web-alb-to-task",
      "wallie-staging-web-task-from-alb",
    ]);
    const createVpc = policy.Statement.find((item: { Sid: string }) => item.Sid === "InVpc");
    expect(createVpc.Resource).toBe("arn:aws:ec2:us-west-2:111614490109:vpc/vpc-0c39dfdf1f090e4ff");
    const updateSg = policy.Statement.find((item: { Sid: string }) => item.Sid === "UpdateSG");
    expect(updateSg.Condition.StringEquals["aws:ResourceTag/Name"]).toEqual([
      "wallie-staging-web-alb",
      "wallie-staging-web-ingress",
    ]);
    const tagRule = policy.Statement.find((item: { Sid: string }) => item.Sid === "TagSGRule");
    expect(tagRule.Action).toBe("ec2:CreateTags");
    expect(tagRule.Resource).toBe(createRule.Resource);
    expect(tagRule.Condition.StringEquals["ec2:CreateAction"]).toEqual([
      "AuthorizeSecurityGroupIngress",
      "AuthorizeSecurityGroupEgress",
    ]);
    expect(JSON.stringify(policy)).not.toContain("worker");
    expect(JSON.stringify(policy)).not.toContain("route53:");
    expect(JSON.stringify(policy)).not.toMatch(
      /DeleteLoadBalancer|DeleteTargetGroup|DeleteSecurityGroup|DeleteCertificate/,
    );
    expect(JSON.stringify(policy).length).toBeLessThanOrEqual(6144);
  });

  it("permits only the staging web service and its execution role", () => {
    const policy = visibleWebGrant("service", config, now);
    const certificate = policy.Statement.find(
      (item: { Action: string }) => item.Action === "acm:RequestCertificate",
    );
    expect(certificate.Condition["ForAllValues:StringEquals"]["acm:DomainNames"]).toEqual([
      "aws-staging.wallie.dev",
    ]);
    expect(JSON.stringify(policy)).toContain("acm:GetCertificate");
    expect(JSON.stringify(policy)).toContain("acm:ListCertificates");
    const create = policy.Statement.find(
      (item: { Action: string }) => item.Action === "ecs:CreateService",
    );
    expect(create.Resource).toBe(
      "arn:aws:ecs:us-west-2:111614490109:service/wallie-staging/wallie-staging-web",
    );
    const pass = policy.Statement.find(
      (item: { Action: string }) => item.Action === "iam:PassRole",
    );
    expect(pass.Resource).toBe("arn:aws:iam::111614490109:role/wallie-staging-web-execution");
    expect(JSON.stringify(policy)).not.toMatch(
      /worker|RunTask|StopTask|DeleteService|ExecuteCommand/,
    );
  });

  it("rejects the wrong account, grant kind, and expiry", () => {
    expect(() =>
      visibleWebGrant("infrastructure", { ...config, account: "999999999999" }, now),
    ).toThrow();
    expect(() => visibleWebGrant("worker", config, now)).toThrow();
    expect(() =>
      visibleWebGrant("service", { ...config, expiresAt: "2026-09-26T20:05:00Z" }, now),
    ).toThrow();
  });
});
