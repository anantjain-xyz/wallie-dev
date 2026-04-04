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
      aria-busy={isPending}
      onSubmit={handleSubmit}
      className="mt-6 grid gap-5 lg:grid-cols-[1.1fr_0.9fr]"
    >
      <section className="ui-panel p-5">
        <div className="space-y-2">
          <p className="text-[11px] font-medium text-muted">Workspace Identity</p>
          <h2 className="text-2xl font-semibold tracking-tight text-balance text-foreground">
            Name the First Workspace
          </h2>
          <p className="text-sm leading-6 text-muted">
            The server owns slug normalization, uniqueness, owner membership, and the system
            `wallie` member bootstrap.
          </p>
        </div>

        <label className="mt-5 block text-sm font-semibold text-foreground">
          Workspace name
          <input
            type="text"
            name="name"
            required
            autoComplete="organization"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Northwind Labs…"
            className="ui-input mt-2 text-base"
          />
        </label>

        <label className="mt-5 block text-sm font-semibold text-foreground">
          Preferred slug
          <span className="mt-1 block text-xs font-normal leading-5 text-muted">
            Optional. If this is taken, Wallie appends a numeric suffix on the server.
          </span>
          <input
            type="text"
            name="slug"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
            placeholder={`${slugifyWorkspaceName(name || "Northwind Labs")}…`}
            className="ui-input mt-2 text-base"
          />
        </label>

        {errorMessage ? (
          <div
            aria-live="polite"
            role="status"
            className="mt-5 rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-sm leading-6 text-danger"
          >
            {errorMessage}
          </div>
        ) : null}

        <button
          type="submit"
          disabled={isPending}
          className="ui-button-primary mt-5 disabled:cursor-wait"
        >
          {isPending ? "Creating Workspace…" : "Create Workspace"}
        </button>
      </section>

      <section className="ui-subpanel p-5">
        <p className="text-[11px] font-medium text-muted">Result</p>
        <h2 className="mt-3 text-2xl font-semibold tracking-tight text-balance text-foreground">
          Entry Route Preview
        </h2>
        <p className="mt-3 text-sm leading-6 text-muted">
          If the workspace is available, the first landing route will be:
        </p>

        <div className="ui-muted-panel mt-5 px-4 py-4 font-mono text-sm text-foreground">
          /w/{slugPreview}/issues
        </div>

        <ul className="mt-5 space-y-3 text-sm leading-6 text-muted">
          <li>Owner membership is created in the same DB transaction.</li>
          <li>The `wallie` system actor is provisioned automatically.</li>
          <li>Workspace access remains membership-scoped under RLS.</li>
        </ul>
      </section>
    </form>
  );
}
