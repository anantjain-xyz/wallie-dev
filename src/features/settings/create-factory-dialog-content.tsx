import { useId, useRef, useState, type FormEvent, type RefObject } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DialogContent, DialogFooter } from "@/components/ui/dialog";
import {
  createFactorySchema,
  FACTORY_NAME_MAX_LENGTH,
  FACTORY_SLUG_MAX_LENGTH,
  FACTORY_SLUG_TAKEN,
} from "@/lib/factories/contracts";
import { slugifyAddress } from "@/lib/slugs";

const factoryReceiptSchema = z.object({ factory: z.object({ id: z.string().uuid() }) });
const genericError = "Could not create the factory. Try again.";

export function CreateFactoryDialogContent({
  closingForNavigation,
  inFlight,
  onCancel,
  onCheck,
  onCreated,
  workspaceId,
  workspaceName,
}: {
  closingForNavigation: RefObject<boolean>;
  inFlight: RefObject<boolean>;
  onCancel: () => void;
  onCheck: () => void;
  onCreated: (factoryId: string) => void;
  workspaceId: string;
  workspaceName: string;
}) {
  const id = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const slugRef = useRef<HTMLInputElement>(null);
  const [submitting, setSubmitting] = useState(false);
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

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || closingForNavigation.current || needsCheck) return;
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
      onCreated(factory.id);
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
            onClick={onCancel}
            type="button"
          >
            Cancel
          </button>
          <button
            className="ui-button-primary min-h-11 sm:min-h-9"
            disabled={submitting}
            onClick={needsCheck ? onCheck : undefined}
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
  );
}
