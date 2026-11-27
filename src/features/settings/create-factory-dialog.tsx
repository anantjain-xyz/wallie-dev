"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition, type FormEvent } from "react";
import { z } from "zod";

import { PlusIcon } from "@/components/shared/icons/plus-icon";
import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { Dialog, DialogContent, DialogFooter, DialogTrigger } from "@/components/ui/dialog";
import {
  createFactorySchema,
  FACTORY_NAME_MAX_LENGTH,
  FACTORY_SLUG_MAX_LENGTH,
  FACTORY_SLUG_TAKEN,
} from "@/lib/factories/contracts";
import { workspaceFactoriesPath } from "@/lib/routes";
import { slugifyAddress } from "@/lib/slugs";

const factoryReceiptSchema = z.object({ factory: z.object({ id: z.string().uuid() }) });
const genericError = "Could not create the factory. Try again.";

export function CreateFactoryDialog({
  workspaceId,
  workspaceName,
  workspaceSlug,
}: {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
}) {
  const router = useRouter();
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const inFlight = useRef(false);
  const closingForNavigation = useRef(false);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [navigating, startNavigation] = useTransition();
  const [name, setName] = useState("");
  const [editedSlug, setEditedSlug] = useState<string | null>(null);
  const [error, setError] = useState<{
    field: "name" | "slug" | "form" | "unconfirmed";
    message: string;
  } | null>(null);
  const needsCheck = error?.field === "unconfirmed";
  const fieldsLocked = submitting || needsCheck;
  const slug =
    editedSlug ?? slugifyAddress(name).slice(0, FACTORY_SLUG_MAX_LENGTH).replace(/-$/, "");

  function changeOpen(next: boolean) {
    if (inFlight.current || navigating) return;
    if (next) {
      closingForNavigation.current = false;
      setName("");
      setEditedSlug(null);
      setError(null);
    }
    setOpen(next);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || navigating || needsCheck) return;
    const parsed = createFactorySchema.safeParse({ name, slug });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue.path[0] === "slug" ? "slug" : "name";
      setError({ field, message: issue.message });
      (field === "slug" ? slugRef : nameRef).current?.focus();
      return;
    }

    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/workspaces/${encodeURIComponent(workspaceId)}/factories`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(parsed.data),
      });
      if (response.status >= 500) throw new Error();
      const payload = (await response.json().catch(() => null)) as {
        code?: unknown;
        error?: unknown;
      } | null;
      if (response.status === 409 && payload?.code === FACTORY_SLUG_TAKEN) {
        setError({ field: "slug", message: "That address is already used in this workspace." });
        slugRef.current?.focus();
        return;
      }
      if (!response.ok) {
        setError({
          field: "form",
          message: typeof payload?.error === "string" ? payload.error : genericError,
        });
        return;
      }

      const { factory } = factoryReceiptSchema.parse(payload);
      closingForNavigation.current = true;
      setOpen(false);
      startNavigation(() => {
        router.push(workspaceFactoriesPath(workspaceSlug, factory.id), {
          scroll: false,
        });
      });
    } catch {
      setError({
        field: "unconfirmed",
        message: "Couldn’t confirm creation. Check the factory list before trying again.",
      });
    } finally {
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  return (
    <Dialog onOpenChange={changeOpen} open={open}>
      <DialogTrigger asChild>
        <button
          className="ui-button-primary min-h-11 gap-1.5 sm:min-h-9"
          disabled={navigating}
          type="button"
        >
          <PlusIcon />
          New factory
        </button>
      </DialogTrigger>
      <DialogContent
        className="max-w-md"
        description={`Create a factory in ${workspaceName} without changing the workspace default.`}
        dismissible={!submitting}
        onCloseAutoFocus={(event) => {
          if (closingForNavigation.current) event.preventDefault();
        }}
        title="New factory"
      >
        <form aria-busy={submitting} className="space-y-4" noValidate onSubmit={create}>
          <div className="space-y-1.5">
            <label className="block type-label" htmlFor={`${id}-name`}>
              Factory name
            </label>
            <input
              aria-describedby={error?.field === "name" ? `${id}-name-error` : undefined}
              aria-invalid={error?.field === "name" || undefined}
              autoComplete="off"
              className="ui-input"
              id={`${id}-name`}
              maxLength={FACTORY_NAME_MAX_LENGTH}
              name="name"
              onChange={(event) => {
                setName(event.currentTarget.value);
                if (error?.field !== "slug" || editedSlug === null) setError(null);
              }}
              readOnly={fieldsLocked}
              ref={nameRef}
              required
              value={name}
            />
            {error?.field === "name" ? (
              <p className="type-secondary text-danger" id={`${id}-name-error`} role="alert">
                {error.message}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <label className="block type-label" htmlFor={`${id}-slug`}>
              Address
            </label>
            <input
              aria-describedby={`${id}-slug-hint${error?.field === "slug" ? ` ${id}-slug-error` : ""}`}
              aria-invalid={error?.field === "slug" || undefined}
              autoCapitalize="none"
              autoComplete="off"
              className="ui-input"
              id={`${id}-slug`}
              maxLength={FACTORY_SLUG_MAX_LENGTH}
              name="slug"
              onChange={(event) => {
                setEditedSlug(event.currentTarget.value);
                if (error?.field !== "name") setError(null);
              }}
              readOnly={fieldsLocked}
              ref={slugRef}
              required
              spellCheck={false}
              value={slug}
            />
            <p className="type-annotation text-muted" id={`${id}-slug-hint`}>
              Suggested from the name. Use lowercase letters, numbers, and single hyphens.
            </p>
            {error?.field === "slug" ? (
              <p className="type-secondary text-danger" id={`${id}-slug-error`} role="alert">
                {error.message}
              </p>
            ) : null}
          </div>
          {error?.field === "form" || needsCheck ? (
            <p className="ui-inline-message ui-inline-message-danger" role="alert">
              {error.message}
            </p>
          ) : null}
          <DialogFooter className="flex-wrap">
            <button
              className="ui-button min-h-11 sm:min-h-9"
              disabled={submitting}
              onClick={() => changeOpen(false)}
              type="button"
            >
              Cancel
            </button>
            <button
              className="ui-button-primary min-h-11 sm:min-h-9"
              disabled={submitting}
              onClick={
                needsCheck
                  ? () => {
                      setOpen(false);
                      router.refresh();
                    }
                  : undefined
              }
              type={needsCheck ? "button" : "submit"}
            >
              <ActionButtonLabel
                idle={needsCheck ? "Check factories" : "Create factory"}
                pending={submitting}
                pendingLabel="Creating…"
              />
            </button>
          </DialogFooter>
        </form>
        <span className="sr-only" role="status">
          {submitting ? "Creating factory." : ""}
        </span>
      </DialogContent>
    </Dialog>
  );
}
