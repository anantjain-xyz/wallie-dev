import { z } from "zod/v4";

const uuid = z.uuid().toLowerCase();
const revision = z.number().int().nonnegative().safe();
const generation = revision.positive();
const scope = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9_:.]*$/);

export const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{2,31}$/);
export const slackAppIdSchema = z.string().regex(/^A[A-Z0-9]{2,31}$/);
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{2,31}$/);
export const slackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]{2,31}$/);

export const slackConnectorSetupSchema = z.strictObject({
  configured: z.boolean(),
  canConfigure: z.boolean(),
  installations: z.array(
    z.strictObject({
      id: uuid,
      teamId: slackTeamIdSchema,
      teamName: z.string().min(1).max(256),
      generation,
      status: z.enum(["connected", "disconnected", "credential_unavailable"]),
      grantedScopes: z.array(scope).max(100),
      missingScopes: z.array(scope).max(100),
      linkedActor: z.strictObject({ id: uuid, userId: slackUserIdSchema }).nullable(),
    }),
  ),
});

export const slackConnectorSetupCommandSchema = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("install"),
    teamId: slackTeamIdSchema,
    expectedGeneration: revision,
  }),
  z.strictObject({
    action: z.literal("link"),
    installationId: uuid,
    expectedGeneration: generation,
  }),
  z.strictObject({ action: z.literal("revoke"), installationId: uuid, linkId: uuid }),
]);

export const slackConnectorSetupResultSchema = z.union([
  z.strictObject({
    authorizationUrl: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.origin === "https://slack.com" &&
        !url.username &&
        !url.password &&
        ["/oauth/v2/authorize", "/openid/connect/authorize"].includes(url.pathname)
      );
    }),
  }),
  z.strictObject({ revoked: z.boolean() }),
]);

export type SlackConnectorSetupCommand = z.output<typeof slackConnectorSetupCommandSchema>;
