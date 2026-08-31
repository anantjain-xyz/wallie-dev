"use client";

import { privilegedValue as valueA } from "@fixtures/parallel-exception/bridge-a";
import { privilegedValue as valueB } from "@fixtures/parallel-exception/bridge-b";

export const leakedValues = [valueA, valueB];
