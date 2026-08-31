"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
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
  const { startNavigation } = useOptionalRouteProgress();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isPending, setIsPending] = useState(false);
  const inFlightRef = useRef(false);

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
      const destination = `/login?next=${encodeURIComponent(onboardingWorkspacePath())}`;
      startNavigation(destination);
      router.replace(destination);
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
      inFlightRef.current = false;
      setIsPending(false);
      return;
    }

    if (payload && "redirectTo" in payload) {
      startNavigation(payload.redirectTo);
      router.replace(payload.redirectTo);
      return;
    }

    setErrorMessage("Wallie could not create that workspace.");
    inFlightRef.current = false;
    setIsPending(false);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;

    const submittedName = name;
    const submittedSlug = slug;

    inFlightRef.current = true;
    setIsPending(true);
    void submitWorkspace(submittedName, submittedSlug).catch((error) => {
      inFlightRef.current = false;
      setIsPending(false);
      setErrorMessage(
        error instanceof Error ? error.message : "Wallie could not create that workspace.",
      );
    });
  }

  return (
    <form aria-busy={isPending} onSubmit={handleSubmit} className="max-w-xl space-y-5">
      <label className="block space-y-1.5" htmlFor="workspace-name">
        <span className="text-[13px] font-medium text-foreground">Workspace name</span>
        <input
          id="workspace-name"
          type="text"
          name="name"
          required
          autoComplete="organization"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Acme Inc"
          className="ui-input"
        />
      </label>

      <label className="block space-y-1.5" htmlFor="workspace-slug">
        <span className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-medium text-foreground">URL slug</span>
          <span aria-hidden="true" className="text-xs text-muted">
            Optional
          </span>
        </span>
        <input
          id="workspace-slug"
          type="text"
          name="slug"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          value={slug}
          onChange={(event) => setSlug(event.target.value)}
          placeholder={slugifyWorkspaceName(name || "Acme Inc")}
          className="ui-input"
        />
      </label>

      {errorMessage ? (
        <div
          aria-live="polite"
          role="status"
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] leading-5 text-danger"
        >
          {errorMessage}
        </div>
      ) : null}

      <div className="flex justify-end">
        <button
          type="submit"
          disabled={isPending}
          className="ui-button-primary disabled:cursor-wait"
        >
          <ActionButtonLabel idle="Create workspace" pending={isPending} pendingLabel="Creating…" />
        </button>
      </div>
    </form>
  );
}
