// Use VERCEL_ENV, not NODE_ENV: on Vercel, both production and preview
// deploys run with NODE_ENV="production", so a NODE_ENV check treats preview
// as production and a flipped check treats preview as dev. VERCEL_ENV
// distinguishes "production" / "preview" / "development"; it is unset
// when running outside Vercel and set to "development" under `vercel dev`.
export const isProductionDeploy = () => process.env.VERCEL_ENV === "production";

export const isPreviewDeploy = () => process.env.VERCEL_ENV === "preview";
