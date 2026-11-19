import { expect, it } from "vitest";

import { issueFactoryMachineTokenSecret, parseFactoryMachineToken } from "./secret";

it("generates a fresh opaque secret and parses only the identifier and digest", () => {
  const { credential, tokenId, digest } = issueFactoryMachineTokenSecret();
  expect(credential).toMatch(/^wallie_mt_[a-f0-9-]+\.[A-Za-z0-9_-]{43}$/);
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  expect(credential).not.toContain(digest);
  expect(parseFactoryMachineToken(`Bearer ${credential}`)).toEqual({ tokenId, digest });
  expect(issueFactoryMachineTokenSecret().digest).not.toBe(digest);
});

it("ignores malformed credentials, wrong schemes, and secretless identifiers", () => {
  const { credential, tokenId } = issueFactoryMachineTokenSecret();
  expect(parseFactoryMachineToken(null)).toBeNull();
  expect(parseFactoryMachineToken(`Basic ${credential}`)).toBeNull();
  expect(parseFactoryMachineToken(`Bearer wallie_mt_${tokenId}`)).toBeNull();
  expect(parseFactoryMachineToken(`Bearer ${credential}, Bearer ${credential}`)).toBeNull();
});
