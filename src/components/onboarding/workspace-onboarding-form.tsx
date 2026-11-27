"use client";

import type { FormEvent } from "react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { useOptionalRouteProgress } from "@/components/ui/route-progress";
import { onboardingWorkspacePath, workspaceBasePath } from "@/lib/routes";
import {
  createWorkspaceInputSchema,
  slugifyWorkspaceName,
  workspaceSlugPattern,
} from "@/lib/workspaces";

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
  const [fieldError, setFieldError] = useState<{ field: "name" | "slug"; message: string } | null>(
    null,
  );
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isEditingAddress, setIsEditingAddress] = useState(false);
  const [isPending, setIsPending] = useState(false);
  const inFlightRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const derivedSlug = slugifyWorkspaceName(name);
  const customSlug = slug.trim();
  const previewSlug =
    customSlug.length <= 63 && workspaceSlugPattern.test(customSlug) ? customSlug : derivedSlug;

  useEffect(() => {
    if (isEditingAddress) addressRef.current?.focus();
  }, [isEditingAddress]);

  useEffect(() => {
    if (fieldError) (fieldError.field === "name" ? nameRef : addressRef).current?.focus();
    if (errorMessage) errorRef.current?.focus();
  }, [errorMessage, fieldError]);

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

    const parsed = createWorkspaceInputSchema.safeParse({ name, slug });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path[0] === "slug" ? "slug" : "name";
      setErrorMessage(null);
      setFieldError({ field, message: issue.message });
      return;
    }

    const submittedName = name;
    const submittedSlug = slug;

    setFieldError(null);
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
      <div className="space-y-1.5">
        <label className="block space-y-1.5" htmlFor="workspace-name">
          <span className="text-[13px] font-medium text-foreground">Workspace name</span>
          <input
            aria-describedby={fieldError?.field === "name" ? "workspace-name-error" : undefined}
            aria-invalid={fieldError?.field === "name" || undefined}
            id="workspace-name"
            type="text"
            name="name"
            required
            autoComplete="organization"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (fieldError?.field === "name") setFieldError(null);
            }}
            placeholder="Example: Acme Studio…"
            ref={nameRef}
            className="ui-input"
          />
        </label>
        {fieldError?.field === "name" ? (
          <span className="block text-xs text-danger" id="workspace-name-error" role="alert">
            {fieldError.message}
          </span>
        ) : null}
      </div>

      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-foreground">Workspace address preview</p>
            <code className="type-code text-muted [overflow-wrap:anywhere]" translate="no">
              {workspaceBasePath(previewSlug)}
            </code>
          </div>
          <button
            aria-controls="workspace-custom-address"
            aria-expanded={isEditingAddress}
            className="ui-button min-h-11"
            disabled={isPending}
            onClick={() => {
              if (isEditingAddress) {
                setSlug("");
                if (fieldError?.field === "slug") setFieldError(null);
              }
              setIsEditingAddress(!isEditingAddress);
            }}
            type="button"
          >
            {isEditingAddress ? "Use suggested address" : "Edit address"}
          </button>
        </div>
        <div hidden={!isEditingAddress} id="workspace-custom-address">
          <label className="block space-y-1.5" htmlFor="workspace-slug">
            <span className="text-[13px] font-medium text-foreground">Custom address</span>
            <input
              aria-describedby={
                fieldError?.field === "slug"
                  ? "workspace-address-hint workspace-slug-error"
                  : "workspace-address-hint"
              }
              aria-invalid={fieldError?.field === "slug" || undefined}
              id="workspace-slug"
              type="text"
              name="slug"
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              value={slug}
              onChange={(event) => {
                setSlug(event.target.value);
                if (fieldError?.field === "slug") setFieldError(null);
              }}
              placeholder={derivedSlug}
              ref={addressRef}
              className="ui-input"
            />
          </label>
          <p className="mt-1 text-xs text-muted" id="workspace-address-hint">
            Use lowercase letters, numbers, and single hyphens.
          </p>
          {fieldError?.field === "slug" ? (
            <p className="mt-1 text-xs text-danger" id="workspace-slug-error" role="alert">
              {fieldError.message}
            </p>
          ) : null}
        </div>
      </div>

      {errorMessage ? (
        <p
          ref={errorRef}
          role="alert"
          tabIndex={-1}
          className="rounded-[6px] border border-danger/20 bg-danger-soft px-4 py-3 text-[13px] leading-5 text-danger"
        >
          {errorMessage}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <button
          type="submit"
          disabled={isPending}
          className="ui-button-primary min-h-11 disabled:cursor-wait"
        >
          <ActionButtonLabel idle="Create workspace" pending={isPending} pendingLabel="Creating…" />
        </button>
        <p className="text-xs leading-5 text-muted">
          Next: connect a repository and execution access.
        </p>
      </div>
    </form>
  );
}
