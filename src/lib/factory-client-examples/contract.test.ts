import { readFile } from "node:fs/promises";
import { expect, expectTypeOf, it } from "vitest";
import type { z } from "zod/v4";

import { factoryReadRoutes } from "@/lib/factory-read-api/contracts";
import {
  factoryMutationErrorSchema,
  factoryMutationResponseSchema,
  factoryMutationRoutes,
} from "@/lib/factory-session-mutations/contracts";

import { factoryOperations } from "../../../packages/factory-client/src/operations";
import type { operations } from "../../../packages/factory-client/src/schema";
import { generateFactoryClientSources } from "../../../scripts/generate-factory-client";

it("keeps the package checked in with the published Factory API contract", async () => {
  const generated = await generateFactoryClientSources();
  const directory = new URL("../../../packages/factory-client/src/", import.meta.url);
  await Promise.all(
    Object.entries(generated).map(async ([filename, source]) => {
      expect(await readFile(new URL(filename, directory), "utf8"), filename).toBe(source);
    }),
  );
});

it("uses one sessions path for reads and idempotent creates", () => {
  expect(factoryOperations.listFactorySessions).toEqual({
    method: "GET",
    path: factoryReadRoutes.sessions.path,
    requiresIdempotencyKey: false,
  });
  expect(factoryOperations.createFactorySession).toEqual({
    method: "POST",
    path: factoryReadRoutes.sessions.path,
    requiresIdempotencyKey: true,
  });
  expect(factoryOperations.cancelFactorySession.path).toBe(factoryMutationRoutes.cancel.path);
});

it("preserves the create body, receipt, and conflict types across the generated API", () => {
  type Create = operations["createFactorySession"];
  type CreateBody = Create["requestBody"]["content"]["application/json"];
  type Original = Create["responses"][201]["content"]["application/json"];
  type Replay = Create["responses"][200]["content"]["application/json"];
  type Conflict = Create["responses"][409]["content"]["application/json"];
  expectTypeOf<CreateBody>().toEqualTypeOf<z.input<typeof factoryMutationRoutes.create.body>>();
  expectTypeOf<Create["parameters"]["header"]["Idempotency-Key"]>().toEqualTypeOf<string>();
  expectTypeOf<Original>().toEqualTypeOf<Replay>();
  expectTypeOf<Replay>().toEqualTypeOf<z.output<typeof factoryMutationResponseSchema>>();
  expectTypeOf<Conflict>().toEqualTypeOf<z.output<typeof factoryMutationErrorSchema>>();
});
