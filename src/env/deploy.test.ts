import { afterEach, describe, expect, it } from "vitest";

import { isProductionDeploy } from "@/env/deploy";

const originalVercelEnv = process.env.VERCEL_ENV;

afterEach(() => {
  if (originalVercelEnv === undefined) {
    delete process.env.VERCEL_ENV;
  } else {
    process.env.VERCEL_ENV = originalVercelEnv;
  }
});

describe("deployment environment", () => {
  it("enables production-only features only on a Vercel production deployment", () => {
    process.env.VERCEL_ENV = "production";
    expect(isProductionDeploy()).toBe(true);

    process.env.VERCEL_ENV = "preview";
    expect(isProductionDeploy()).toBe(false);

    process.env.VERCEL_ENV = "development";
    expect(isProductionDeploy()).toBe(false);

    delete process.env.VERCEL_ENV;
    expect(isProductionDeploy()).toBe(false);
  });
});
