"use client";

import type { AdminShape } from "@fixtures/type-only/barrel";

export type BrowserShape = Pick<AdminShape, "secret">;
