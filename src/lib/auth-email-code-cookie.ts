export const emailCodeAuthCookieName = "wallie_email_code_address";

export const emailCodeAuthCookieOptions = {
  httpOnly: true,
  maxAge: 10 * 60,
  path: "/",
  sameSite: "lax" as const,
  secure: process.env.NODE_ENV === "production",
};

export function normalizeEmailCodeAddress(value: string | null | undefined) {
  return String(value ?? "")
    .trim()
    .toLowerCase();
}
