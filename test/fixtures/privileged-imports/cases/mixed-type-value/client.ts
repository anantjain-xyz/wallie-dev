"use client";

import { type AdminShape, privilegedValue } from "@fixtures/mixed-type-value/admin";

export const leakedValue: AdminShape = { secret: privilegedValue };
