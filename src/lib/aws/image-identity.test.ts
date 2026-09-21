import { beforeAll, describe, expect, it } from "vitest";

let stableAwsIdentity: (identity: unknown, account: string, partition: string) => string;
beforeAll(async () => {
  const helper = new URL("../../../scripts/lib/aws-image-identity.mjs", import.meta.url).href;
  ({ stableAwsIdentity } = await import(helper));
});

const account = "123456789012";
const roleId = "AROAABCDEFGHIJKLMNOPQ";
const userId = "AIDAABCDEFGHIJKLMNOPQ";
const role = (session = "credential-process-1", name = "wallie-publisher", id = roleId) => ({
  Account: account,
  Arn: `arn:aws:sts::${account}:assumed-role/${name}/${session}`,
  UserId: `${id}:${session}`,
});
const user = {
  Account: account,
  Arn: `arn:aws:iam::${account}:user/engineering/wallie-publisher`,
  UserId: userId,
};
const federated = (name = "publisher-1") => ({
  Account: account,
  Arn: `arn:aws:sts::${account}:federated-user/${name}`,
  UserId: `${account}:${name}`,
});
const key = (identity: unknown) => stableAwsIdentity(identity, account, "aws");

describe("stable AWS publishing identity", () => {
  it("allows the same assumed role to refresh with a different session name", () => {
    expect(key(role("credential-process-1"))).toBe(key(role("credential-process-2")));
    expect(key(role("anant@example.test", "AWSReservedSSO_Publisher_1234567890abcdef"))).toBe(
      key(role("refreshed-session", "AWSReservedSSO_Publisher_1234567890abcdef")),
    );
  });

  it("preserves the entire role ARN path and its case while removing only the session", () => {
    const path = "aws-reserved/sso.amazonaws.com/us-west-2/WalliePublisher";
    expect(key(role("session-one", path))).toBe(key(role("session-two", path)));
    expect(key(role("session-one", path))).not.toBe(key(role("session-one", "WalliePublisher")));
    expect(key(role("session-one", path))).not.toBe(key(role("session-one", path.toLowerCase())));
  });

  it("rejects equivalence for different roles and roles recreated under the same name", () => {
    expect(key(role())).not.toBe(key(role("credential-process-2", "other-role")));
    expect(key(role())).not.toBe(
      key(role("credential-process-2", "wallie-publisher", "AROAQRSTUVWXYZABCDEFG")),
    );
  });

  it("preserves the IAM user's full ARN and unique ID", () => {
    expect(key(user)).toBe(key({ ...user }));
    expect(key(user)).not.toBe(key({ ...user, UserId: "AIDAQRSTUVWXYZABCDEFG" }));
    expect(key(user)).not.toBe(
      key({ ...user, Arn: user.Arn.replace("engineering/", "operations/") }),
    );
    expect(key(user)).not.toBe(key({ ...user, Arn: user.Arn.replace("publisher", "Publisher") }));
  });

  it("accepts documented identifier length bounds without assuming 21 characters", () => {
    for (const length of [16, 128]) {
      expect(key(role("session-one", "publisher", `AROA${"X".repeat(length - 4)}`))).toBe(
        key(role("session-two", "publisher", `AROA${"X".repeat(length - 4)}`)),
      );
      expect(() => key({ ...user, UserId: `AIDA${"X".repeat(length - 4)}` })).not.toThrow();
    }
  });

  it("keeps valid federated users exact without normalizing their name", () => {
    expect(key(federated())).toBe(key(federated()));
    expect(key(federated())).not.toBe(key(federated("publisher-2")));
    expect(() => key({ ...federated(), UserId: `${account}:different-name` })).toThrow();
  });

  it.each(["aws", "aws-cn", "aws-us-gov"])(
    "binds identities to their %s partition",
    (partition) => {
      const identity = { ...role(), Arn: role().Arn.replace("arn:aws:", `arn:${partition}:`) };
      expect(() => stableAwsIdentity(identity, account, partition)).not.toThrow();
      if (partition !== "aws") expect(() => key(identity)).toThrow(/account\/partition/);
    },
  );

  it.each([
    { ...role(), Account: "999999999999" },
    { ...role(), Arn: role().Arn.replace(account, "999999999999") },
    { ...user, Account: "999999999999" },
    { ...federated(), Arn: federated().Arn.replace(account, "999999999999") },
  ])("rejects a mismatch between STS Account, ARN account, and the destination", (identity) => {
    expect(() => key(identity)).toThrow(/account\/partition/);
  });

  it.each([
    null,
    [],
    {},
    { ...role(), UserId: undefined },
    { ...role(), UserId: roleId },
    { ...role(), UserId: `${roleId}:different-session` },
    { ...role(), UserId: `${roleId}:credential-process-1:extra` },
    { ...role(), UserId: `${userId}:credential-process-1` },
    { ...role(), UserId: `AROAshort:credential-process-1` },
    { ...role(), UserId: `AROA${"X".repeat(125)}:credential-process-1` },
    { ...role(), Arn: `arn:aws:sts::${account}:assumed-role/role` },
    { ...role(), Arn: `arn:aws:sts::${account}:assumed-role//credential-process-1` },
    { ...role(), Arn: `${role().Arn}/` },
    { ...role(), Arn: role().Arn.replace("sts::", "sts:us-west-2:") },
    { ...role(), Arn: `${role().Arn}\n` },
    { ...role(), UserId: `${role().UserId}\n` },
    { ...user, UserId: roleId },
    { ...user, UserId: `${userId}:session` },
    { ...user, Arn: `arn:aws:iam::${account}:user/` },
    { ...user, Arn: `arn:aws:iam::${account}:role/publisher` },
    { Account: account, Arn: `arn:aws:iam::${account}:root`, UserId: account },
    { Account: account, Arn: `arn:aws:sts::${account}:self`, UserId: account },
    { ...federated(), UserId: "999999999999:publisher-1" },
    federated("contains/a/slash"),
    role("x"),
    role("x".repeat(65)),
    role("contains space"),
    role("session", "x".repeat(65)),
    role("session", `${"x".repeat(511)}/publisher`),
  ])("fails closed for malformed or unsupported identities %#", (identity) => {
    expect(() => key(identity)).toThrow(/AWS identity/);
  });

  it("validates the expected account and partition arguments", () => {
    expect(() => stableAwsIdentity(user, `${account}\n`, "aws")).toThrow();
    expect(() => stableAwsIdentity(user, account, "aws-other")).toThrow();
  });
});
