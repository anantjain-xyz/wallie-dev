import "server-only";

import { z } from "zod";

import type { VercelProjectOption, VercelTeamOption } from "@/lib/vercel-sandbox/contracts";

const target = z.object({
  id: z.string().trim().min(1).max(128),
  name: z.string().trim().min(1).max(256),
});
const team = target
  .extend({
    name: target.shape.name.nullish(),
    slug: z.string().trim().min(1).max(256),
  })
  .transform((item) => ({ ...item, name: item.name ?? item.slug }));
const project = target.extend({ accountId: z.string().optional() });
const pagination = z.object({
  next: z.union([z.number().int().nonnegative(), z.string().min(1).max(2048)]).nullable(),
});
const teamsPage = z.object({ teams: z.array(team), pagination });
const projectsPage = z.union([
  z.object({ projects: z.array(project), pagination }),
  z.array(project).transform((projects) => ({ projects, pagination: { next: null } })),
]);

export const vercelTargetLookupInput = z.object({
  teamId: target.shape.id.optional(),
  token: z.string().trim().min(1).max(4000),
});

type VercelTargetCatalog =
  | { ok: true; teams: VercelTeamOption[] }
  | { ok: true; projects: VercelProjectOption[] }
  | { ok: false; error: string; status: number };

export async function lookupVercelTargets({
  input,
  signal,
}: {
  input: z.infer<typeof vercelTargetLookupInput>;
  signal: AbortSignal;
}): Promise<VercelTargetCatalog> {
  const { teamId, token } = input;
  const url = new URL(teamId ? "/v10/projects" : "/v2/teams", "https://api.vercel.com");
  url.searchParams.set("limit", "100");
  if (teamId) url.searchParams.set("teamId", teamId);

  const teams = new Map<string, VercelTeamOption>();
  const projects = new Map<string, VercelProjectOption>();
  const seenCursors = new Set<string>();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
  const unavailable = {
    ok: false,
    error: "Couldn’t load Vercel targets. Retry or enter IDs manually.",
    status: 502,
  } as const;

  try {
    for (let pageIndex = 0; pageIndex < 10; pageIndex++) {
      const response = await fetch(url.toString(), {
        cache: "no-store",
        headers: { Authorization: `Bearer ${token}` },
        redirect: "error",
        signal: deadline,
      });
      if ([401, 403, 404].includes(response.status)) {
        return {
          ok: false,
          error:
            "This token couldn’t list those Vercel targets. Check its access or enter IDs manually.",
          status: 422,
        };
      }
      if (!response.ok) return unavailable;

      const body: unknown = await response.json();
      let next: string | number | null;
      if (teamId) {
        const page = projectsPage.safeParse(body);
        if (!page.success) return unavailable;
        for (const { accountId, id, name } of page.data.projects) {
          if (!accountId || accountId === teamId) projects.set(id, { id, name });
        }
        next = page.data.pagination.next;
      } else {
        const page = teamsPage.safeParse(body);
        if (!page.success) return unavailable;
        for (const item of page.data.teams) teams.set(item.id, item);
        next = page.data.pagination.next;
      }

      if (next === null) {
        return teamId
          ? { ok: true, projects: [...projects.values()] }
          : { ok: true, teams: [...teams.values()] };
      }
      const cursor = String(next);
      if (seenCursors.has(cursor)) return unavailable;
      seenCursors.add(cursor);
      url.searchParams.set(teamId ? "from" : "until", cursor);
    }
  } catch {
    return unavailable;
  }

  return {
    ok: false,
    error: "The Vercel catalog is too large to list here. Enter the target IDs manually.",
    status: 422,
  };
}
