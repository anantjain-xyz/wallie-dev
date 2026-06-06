import "server-only";

import { createHmac, timingSafeEqual } from "node:crypto";

import { resolveGitHubAuthorOAuthConfig } from "@/features/github/config";
import type { GitHubAuthorIdentitySummary } from "@/features/github/contracts";
import { parseServerEnv } from "@/env/server";
import type { Database, Tables } from "@/lib/supabase/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

const authorStateVersion = 1;
const maxStateAgeMs = 60 * 60 * 1000;
const githubApiVersion = "2022-11-28";

type AdminClient = SupabaseClient<Database>;

type GitHubAuthorState = {
  createdAt: string;
  source: "onboarding" | "settings";
  userId: string;
  version: 1;
  workspaceId: string;
  workspaceSlug: string;
};

type GitHubOAuthTokenResponse =
  | {
      access_token: string;
      token_type: string;
    }
  | {
      error: string;
      error_description?: string;
    };

type GitHubUserResponse = {
  avatar_url: string | null;
  email: string | null;
  id: number;
  login: string;
  name: string | null;
};

export type GitHubCommitAuthor = {
  email: string;
  name: string;
};

export class GitHubAuthorMissingError extends Error {
  readonly code = "github_author_missing";
  readonly statusCode = 409;

  constructor(message = "Connect your GitHub commit author identity before starting Wallie.") {
    super(message);
    this.name = "GitHubAuthorMissingError";
  }
}

function encodeBase64Url(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64Url(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function getSigningKey(input: Record<string, string | undefined> = process.env) {
  return parseServerEnv(input).WALLIE_ENCRYPTION_KEY;
}

function createSignature(payload: string, input: Record<string, string | undefined> = process.env) {
  return createHmac("sha256", getSigningKey(input)).update(payload).digest("base64url");
}

export function createGitHubAuthorState(
  payload: Omit<GitHubAuthorState, "createdAt" | "source" | "version"> &
    Partial<Pick<GitHubAuthorState, "source">>,
  input: Record<string, string | undefined> = process.env,
) {
  const encodedPayload = encodeBase64Url(
    JSON.stringify({
      ...payload,
      createdAt: new Date().toISOString(),
      source: payload.source ?? "settings",
      version: authorStateVersion,
    } satisfies GitHubAuthorState),
  );
  const signature = createSignature(encodedPayload, input);

  return `${encodedPayload}.${signature}`;
}

export function verifyGitHubAuthorState(
  token: string | null | undefined,
  input: Record<string, string | undefined> = process.env,
) {
  if (!token) return null;

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) return null;

  const expectedSignature = createSignature(encodedPayload, input);
  const validSignature =
    expectedSignature.length === signature.length &&
    timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature));

  if (!validSignature) return null;

  let parsed: GitHubAuthorState;

  try {
    parsed = JSON.parse(decodeBase64Url(encodedPayload)) as GitHubAuthorState;
  } catch {
    return null;
  }

  if (parsed.version !== authorStateVersion) return null;
  if (parsed.source !== "onboarding") parsed.source = "settings";

  const ageMs = Date.now() - new Date(parsed.createdAt).getTime();
  if (Number.isNaN(ageMs) || ageMs < 0 || ageMs > maxStateAgeMs) return null;

  return parsed;
}

export function buildGitHubNoReplyEmail(githubUserId: number, login: string) {
  return `${githubUserId}+${login.toLowerCase()}@users.noreply.github.com`;
}

export function mapGitHubAuthorIdentityRow(
  row: Tables<"user_github_identities">,
): GitHubAuthorIdentitySummary {
  return {
    authorEmail: row.author_email,
    authorEmailSource: row.author_email_source as GitHubAuthorIdentitySummary["authorEmailSource"],
    authorEmailVerifiedAt: row.author_email_verified_at,
    authorName: row.author_name,
    connectedAt: row.connected_at,
    githubAvatarUrl: row.github_avatar_url,
    githubLogin: row.github_login,
    githubUserId: row.github_user_id,
    updatedAt: row.updated_at,
    userId: row.user_id,
  };
}

export async function loadGitHubAuthorIdentityForUser(admin: AdminClient, userId: string) {
  const { data, error } = await admin
    .from("user_github_identities")
    .select(
      "user_id, github_user_id, github_login, github_avatar_url, author_name, author_email, author_email_source, connected_at, author_email_verified_at, created_at, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data ? mapGitHubAuthorIdentityRow(data) : null;
}

export async function resolveCommitAuthorForMember(
  admin: AdminClient,
  memberId: string | null | undefined,
): Promise<GitHubCommitAuthor | null> {
  if (!memberId) return null;

  const { data: member, error: memberError } = await admin
    .from("workspace_members")
    .select("id, user_id, full_name, email")
    .eq("id", memberId)
    .maybeSingle();

  if (memberError) throw memberError;
  if (!member?.user_id) return null;

  const identity = await loadGitHubAuthorIdentityForUser(admin, member.user_id);
  if (!identity) return null;

  return {
    email: identity.authorEmail,
    name: identity.authorName,
  };
}

export async function resolveCommitAuthorForRun(
  admin: AdminClient,
  input: {
    fallbackMemberId: string | null | undefined;
    requestedByMemberId: string | null | undefined;
  },
): Promise<GitHubCommitAuthor> {
  const effectiveMemberId = input.requestedByMemberId ?? input.fallbackMemberId;
  const author = await resolveCommitAuthorForMember(admin, effectiveMemberId);

  if (!author) {
    throw new GitHubAuthorMissingError();
  }

  return author;
}

export async function exchangeGitHubAuthorCode(
  code: string,
  redirectUri: string,
  input: Record<string, string | undefined> = process.env,
) {
  const config = resolveGitHubAuthorOAuthConfig(input);
  const params = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: redirectUri,
  });
  const response = await fetch("https://github.com/login/oauth/access_token", {
    body: params,
    headers: {
      Accept: "application/json",
    },
    method: "POST",
  });
  const payload = (await response.json()) as GitHubOAuthTokenResponse;

  if (!response.ok || !("access_token" in payload)) {
    const message =
      "error_description" in payload && payload.error_description
        ? payload.error_description
        : "GitHub author authorization failed.";
    throw new Error(message);
  }

  return payload.access_token;
}

export async function fetchGitHubAuthorUser(accessToken: string) {
  const response = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${accessToken}`,
      "X-GitHub-Api-Version": githubApiVersion,
    },
  });

  if (!response.ok) {
    throw new Error("GitHub user lookup failed.");
  }

  return (await response.json()) as GitHubUserResponse;
}

export async function upsertGitHubAuthorIdentityForUser(input: {
  admin: AdminClient;
  githubUser: GitHubUserResponse;
  userId: string;
}) {
  const now = new Date().toISOString();
  const login = input.githubUser.login.trim();
  const authorName = input.githubUser.name?.trim() || login;
  const authorEmail = buildGitHubNoReplyEmail(input.githubUser.id, login);

  const { data, error } = await input.admin
    .from("user_github_identities")
    .upsert(
      {
        author_email: authorEmail,
        author_email_source: "github_noreply",
        author_email_verified_at: now,
        author_name: authorName,
        connected_at: now,
        github_avatar_url: input.githubUser.avatar_url,
        github_login: login,
        github_user_id: input.githubUser.id,
        user_id: input.userId,
      },
      { onConflict: "user_id" },
    )
    .select(
      "user_id, github_user_id, github_login, github_avatar_url, author_name, author_email, author_email_source, connected_at, author_email_verified_at, created_at, updated_at",
    )
    .single();

  if (error) throw error;
  return mapGitHubAuthorIdentityRow(data);
}
