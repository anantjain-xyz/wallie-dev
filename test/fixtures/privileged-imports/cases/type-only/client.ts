"use client";

import type { AdminShape } from "@fixtures/type-only/admin";

export type BrowserShape = Pick<AdminShape, "secret">;
