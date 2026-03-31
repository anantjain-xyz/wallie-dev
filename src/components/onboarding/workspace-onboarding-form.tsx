"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { onboardingWorkspacePath } from "@/lib/routes";
import { slugifyWorkspaceName } from "@/lib/workspaces";

type CreateWorkspaceResponse = {
  redirectTo: string;
  workspace: {
    id: string;
    name: string;
    slug: string;
  };
};

export function WorkspaceOnboardingForm() {
  const router = useRouter();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isPending, startTransition] = useTransition();

  const slugPreview = slug.trim() || slugifyWorkspaceName(name);

  async function submitWorkspace(submittedName: string, submittedSlug: string) {
    setErrorMessage(null);

    const response = await fetch("/api/workspaces", {
      body: JSON.stringify({
        name: submittedName,
        slug: submittedSlug,
      }),
      headers: {
        "Content-Type": "application/json",
      },
      method: "POST",
    });

    if (response.status === 401) {
      router.replace(`/login?next=${encodeURIComponent(onboardingWorkspacePath())}`);
      return;
    }

    const payload = (await response.json().catch(() => null)) as
      | CreateWorkspaceResponse
      | { error?: string }
      | null;

    if (!response.ok) {
      setErrorMessage(
        payload && "error" in payload && payload.error
          ? payload.error
          : "Wallie could not create that workspace.",
      );
      return;
    }

    if (payload && "redirectTo" in payload) {
      router.replace(payload.redirectTo);
      return;
    }

    setErrorMessage("Wallie could not create that workspace.");
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const submittedName = name;
    const submittedSlug = slug;

    startTransition(() => {
      void submitWorkspace(submittedName, submittedSlug);
    });
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mt-6 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]"
    >
      <section className="rounded-[1.75rem] border border-border/80 bg-surface-strong/80 p-5">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.26em] text-muted">
            Workspace Identity
          </p>
          <h2 className="text-2xl font-semibold tracking-tight text-foreground">
            Name the first workspace
          </h2>
          <p className="text-sm leading-6 text-muted">
            The server owns slug normalization, uniqueness, owner membership, and
            the system `wallie` member bootstrap.
          </p>
        </div>

        <label className="mt-5 block text-sm font-semibold text-foreground">
          Workspace name
          <input
            type="text"
            name="name"
            required
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Northwind Labs"
            className="mt-2 w-full rounded-2xl border border-border/80 bg-background/70 px-4 py-3 text-base text-foreground outline-none transition focus:border-accent/45"
          />
        </label>

        <label className="mt-5 block text-sm font-semibold text-foreground">
          Preferred slug
          <span className="mt-1 block text-xs font-normal leading-5 text-muted">
            Optional. If this is taken, Wallie appends a numeric suffix on the
            server.
          </span>
          <input
            type="text"
            name="slug"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder={slugifyWorkspaceName(name || "Northwind Labs")}
            className="mt-2 w-full rounded-2xl border border-border/80 bg-background/70 px-4 py-3 text-base text-foreground outline-none transition focus:border-accent/45"
          />
        </label>

        {errorMessage ? (
          <div className="mt-5 rounded-[1.5rem] border border-red-400/50 bg-red-500/10 px-4 py-3 text-sm leading-6 text-red-900">
            {errorMessage}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isPending}
          className="mt-5 rounded-full bg-foreground px-5 py-3 text-sm font-semibold text-background transition hover:translate-y-[-1px] disabled:cursor-wait disabled:opacity-70"
        >
          {isPending ? "Creating workspace..." : "Create workspace"}
        </button>
      </section>

      <section className="rounded-[1.75rem] border border-border/80 bg-foreground p-5 text-background">
        <p className="text-xs font-semibold uppercase tracking-[0.26em] text-background/70">
          Result
        </p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight">
          Entry route preview
        </h2>
        <p className="mt-3 text-sm leading-6 text-background/88">
          If the workspace is available, the first landing route will be:
        </p>

        <div className="mt-5 rounded-[1.5rem] border border-white/15 bg-white/8 px-4 py-4 font-mono text-sm text-background/95">
          /w/{slugPreview}/issues
        </div>

        <ul className="mt-5 space-y-3 text-sm leading-6 text-background/88">
          <li>Owner membership is created in the same DB transaction.</li>
          <li>The `wallie` system actor is provisioned automatically.</li>
          <li>Workspace access remains membership-scoped under RLS.</li>
        </ul>
      </section>
    </form>
  );
}
