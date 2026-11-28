import { z } from "zod";

import { addressSlugPattern } from "@/lib/slugs";

export const FACTORY_NAME_MAX_LENGTH = 120;
export const FACTORY_SLUG_MAX_LENGTH = 60;
export const FACTORY_SLUG_TAKEN = "factory_slug_taken";
export const FACTORY_SLUG_CHANGED = "factory_slug_changed";
export const FACTORY_SLUG_TAKEN_MESSAGE =
  "That factory slug is already reserved in this workspace. Choose another.";

export const factoryNameSchema = z
  .string()
  .trim()
  .min(1, "Enter a factory name.")
  .max(FACTORY_NAME_MAX_LENGTH, `Use ${FACTORY_NAME_MAX_LENGTH} characters or fewer.`);

export const factorySlugSchema = z
  .string()
  .trim()
  .min(1, "Enter a factory slug.")
  .max(FACTORY_SLUG_MAX_LENGTH, `Use ${FACTORY_SLUG_MAX_LENGTH} characters or fewer.`)
  .regex(addressSlugPattern, "Use lowercase letters, numbers, and single hyphens for the slug.");

export const createFactorySchema = z
  .object({
    name: factoryNameSchema,
    slug: factorySlugSchema,
  })
  .strict();
