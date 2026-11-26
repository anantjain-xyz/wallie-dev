"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition, type FormEvent, type Ref } from "react";
import { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { SelectField } from "@/components/ui/select";
import { useOptionalToast } from "@/components/ui/toast";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import { contextSourceCommandSchema } from "@/lib/factory-context/contracts";
import { factoryMemoryCommandSchema } from "@/lib/factory-memory/contracts";
import { workspaceContextPath, workspaceMemoryPath } from "@/lib/routes";

import type { ContextRepositoryOption, MemoryIdentity } from "./content-data";

type Scope = { workspaceId: string; workspaceSlug: string; factoryId: string };
type ContextCommand = z.output<typeof contextSourceCommandSchema>;
type MemoryCommand = z.output<typeof factoryMemoryCommandSchema>;
const resultId = z.object({ id: z.string().uuid() });
const pendingMemoryResult = z.object({
  memory: resultId.extend({ pending_revision_id: z.string().uuid() }),
});
type MemoryListQuery = { q?: string; after?: string };

function useContentCommand(
  scope: Scope,
  resource: "context-sources" | "memories",
  memoryListQuery?: MemoryListQuery,
) {
  const router = useRouter();
  const { pushToast } = useOptionalToast();
  const [message, setMessage] = useState<FlashMessage | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<ContextCommand | MemoryCommand>();
  const action = useApiAction<unknown, [ContextCommand | MemoryCommand]>({
    call: async (command) => {
      setPendingCommand(command);
      const response = await fetch(
        `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/${resource}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(command),
        },
      );
      return resource === "context-sources" && response.status === 409
        ? Response.json(
            { error: "This item changed. Reload it before trying again." },
            { status: 409 },
          )
        : response;
    },
    errorText: "Could not save the change.",
    setFlashMessage: setMessage,
    onSuccess(payload, [command]) {
      setConfirm(false);
      if (command.action === "register") {
        const parsed = z.object({ source: resultId }).parse(payload);
        router.push(
          workspaceContextPath(scope.workspaceSlug, {
            factory: scope.factoryId,
            source: parsed.source.id,
          }),
        );
      } else if (command.action === "propose" || command.action === "correct") {
        const { memory } = pendingMemoryResult.parse(payload);
        router.push(
          workspaceMemoryPath(scope.workspaceSlug, {
            factory: scope.factoryId,
            ...memoryListQuery,
            memory: memory.id,
            revision: memory.pending_revision_id,
          }),
        );
        pushToast({
          title:
            command.action === "propose" ? "Memory imported for review" : "Pending revision saved",
          tone: "success",
        });
      } else {
        if (command.action === "review") {
          pushToast({
            title: command.decision === "approve" ? "Revision approved" : "Revision rejected",
            tone: "success",
          });
        } else if (command.action === "forget") {
          pushToast({ title: "Memory forgotten", tone: "success" });
        }
        router.refresh();
      }
    },
  });
  const run = (command: ContextCommand | MemoryCommand) => {
    setMessage(null);
    return action.run(command);
  };
  return {
    ...action,
    run,
    message,
    setMessage,
    confirm,
    setConfirm,
    pendingCommand: action.isBusy ? pendingCommand : undefined,
  };
}

export function ContextRegistration({
  scope,
  options,
}: {
  scope: Scope;
  options: ContextRepositoryOption[];
}) {
  const action = useContentCommand(scope, "context-sources");
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const option = options[Number(data.get("repository")) - 1];
    const parsed = contextSourceCommandSchema.safeParse({
      action: "register",
      repositoryId: option?.repository_id,
      grantId: option?.grant_id,
      grantVersion: option?.grant_version,
      filePath: data.get("path"),
    });
    if (!parsed.success) {
      action.setMessage({
        kind: "error",
        text: "Choose an authorized repository and enter a repository-relative Markdown or text path.",
      });
      return;
    }
    void action.run(parsed.data);
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={action.message} />
      <fieldset className="min-w-0 space-y-4" aria-busy={action.isBusy} disabled={action.isBusy}>
        <legend className="sr-only">Source details</legend>
        <SelectField
          defaultValue=""
          emptyOption={{ disabled: true, label: "Choose a repository", value: "" }}
          label="Repository and grant"
          labelClassName="type-label"
          name="repository"
          options={options.map((option, i) => ({
            label: `${option.repository_full_name} · Grant ${option.grant_id.slice(0, 8)} · v${option.grant_version}`,
            value: String(i + 1),
          }))}
          required
          wrap
        />
        <label className="block space-y-1.5">
          <span className="type-label">Document path</span>
          <input
            className="ui-input w-full"
            name="path"
            placeholder="docs/architecture.md"
            maxLength={512}
            required
          />
        </label>
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Register source"
            pending={action.isBusy}
            pendingLabel="Registering…"
          />
        </button>
      </fieldset>
    </form>
  );
}

export function ContextSourceActions({
  scope,
  sourceId,
  canSync,
}: {
  scope: Scope;
  sourceId: string;
  canSync: boolean;
}) {
  const action = useContentCommand(scope, "context-sources");
  return (
    <div className="space-y-3">
      <InlineActionMessage message={action.confirm ? null : action.message} />
      <div className="flex flex-wrap gap-2">
        <button
          className="ui-button ui-button-primary"
          disabled={!canSync || action.isBusy}
          onClick={() => void action.run({ action: "sync", sourceId })}
          type="button"
        >
          <ActionButtonLabel
            idle="Sync source"
            pending={action.isBusy && !action.confirm}
            pendingLabel="Syncing…"
          />
        </button>
        <DestructiveConfirmationDialog
          actionLabel="Remove source"
          description="New runs will stop using this source. Earlier receipt identities remain in run history."
          errorMessage={action.message?.kind === "error" ? action.message.text : null}
          onConfirm={() => void action.run({ action: "remove", sourceId })}
          onOpenChange={action.setConfirm}
          open={action.confirm}
          pending={action.isBusy}
          pendingLabel="Removing…"
          title="Remove context source?"
          trigger={
            <button className="ui-button" disabled={action.isBusy} type="button">
              Remove source
            </button>
          }
        />
      </div>
    </div>
  );
}

function expiry(data: FormData) {
  const value = data.get("expiry");
  if (typeof value !== "string" || !value) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.valueOf()) ? date.toISOString() : "invalid";
}

function localExpiryValue(instant: string) {
  const expiry = new Date(instant);
  const local = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function ExpiryField({ inputRef }: { inputRef?: Ref<HTMLInputElement> }) {
  return (
    <label className="block min-w-0 space-y-1.5">
      <span className="type-label">Expiry in your local time</span>
      <input
        ref={inputRef}
        className="ui-input w-full sm:w-auto"
        type="datetime-local"
        name="expiry"
      />
    </label>
  );
}

export function RetryMemoryProposal() {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <button
      className="ui-button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      type="button"
    >
      <ActionButtonLabel idle="Try again" pending={pending} pendingLabel="Checking…" />
    </button>
  );
}

export function MemoryProposalForm({
  scope,
  artifactId,
  artifactVersion,
  listQuery,
}: {
  scope: Scope;
  artifactId: string;
  artifactVersion: number;
  listQuery: MemoryListQuery;
}) {
  const action = useContentCommand(scope, "memories", listQuery);
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const command = factoryMemoryCommandSchema.safeParse({
      action: "propose",
      artifactId,
      artifactVersion,
      title: data.get("title"),
      expiresAt: expiry(data),
    });
    if (!command.success) {
      action.setMessage({
        kind: "error",
        text: "Enter a title and a valid expiry, or leave expiry blank.",
      });
      return;
    }
    if (
      command.data.action === "propose" &&
      command.data.expiresAt &&
      Date.parse(command.data.expiresAt) <= Date.now()
    ) {
      action.setMessage({ kind: "error", text: "Choose a future expiry, or leave it blank." });
      return;
    }
    void action.run(command.data);
  }
  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={action.message} />
      <fieldset className="min-w-0 space-y-4" aria-busy={action.isBusy} disabled={action.isBusy}>
        <legend className="sr-only">Memory proposal details</legend>
        <label className="block space-y-1.5">
          <span className="type-label">Memory title</span>
          <input className="ui-input w-full" name="title" required maxLength={120} />
        </label>
        <ExpiryField />
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Import for review"
            pending={action.isBusy}
            pendingLabel="Importing…"
          />
        </button>
      </fieldset>
    </form>
  );
}

export function MemoryRevisionActions({
  scope,
  memory,
  body,
  expiresAt,
  canReview,
  approvalBlockedReason,
  listQuery,
}: {
  scope: Scope;
  memory: MemoryIdentity;
  body: string | null;
  expiresAt: string | null;
  canReview: boolean;
  approvalBlockedReason?: string;
  listQuery: MemoryListQuery;
}) {
  const action = useContentCommand(scope, "memories", listQuery);
  const pendingDecision =
    action.pendingCommand?.action === "review" ? action.pendingCommand.decision : undefined;
  const expiryInput = useCallback(
    (input: HTMLInputElement | null) => {
      // A datetime-local control uses the browser timezone. Set its initial value after hydration.
      if (input && expiresAt) input.defaultValue = localExpiryValue(expiresAt);
    },
    [expiresAt],
  );
  const expected = {
    memoryId: memory.id,
    expectedCurrentRevisionId: memory.current_revision_id,
    expectedPendingRevisionId: memory.pending_revision_id,
  };
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const expiryValue = data.get("expiry");
    const unchanged =
      expiryValue === null || (expiresAt && expiryValue === localExpiryValue(expiresAt));
    const command = factoryMemoryCommandSchema.safeParse({
      action: "correct",
      ...expected,
      body: data.get("body"),
      expiresAt: unchanged ? (expiresAt ?? undefined) : expiry(data),
    });
    if (!command.success) {
      action.setMessage({
        kind: "error",
        text: "Enter up to 4 KiB of nonempty Markdown and an optional valid expiry.",
      });
      return;
    }
    if (
      command.data.action === "correct" &&
      command.data.expiresAt &&
      Date.parse(command.data.expiresAt) <= Date.now()
    ) {
      action.setMessage({ kind: "error", text: "Choose a future expiry, or leave it blank." });
      return;
    }
    void action.run(command.data);
  }
  return (
    <div className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5">
      <InlineActionMessage message={action.confirm ? null : action.message} />
      {approvalBlockedReason && (
        <p className="type-secondary text-muted" id="memory-approval-blocked">
          {approvalBlockedReason}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {canReview && (
          <>
            <button
              className="ui-button ui-button-primary"
              aria-describedby={approvalBlockedReason ? "memory-approval-blocked" : undefined}
              disabled={action.isBusy || Boolean(approvalBlockedReason)}
              onClick={() =>
                void action.run({ action: "review", ...expected, decision: "approve" })
              }
              type="button"
            >
              <ActionButtonLabel
                idle="Approve revision"
                pending={pendingDecision === "approve"}
                pendingLabel="Approving…"
              />
            </button>
            <button
              className="ui-button"
              disabled={action.isBusy}
              onClick={() => void action.run({ action: "review", ...expected, decision: "reject" })}
              type="button"
            >
              <ActionButtonLabel
                idle="Reject revision"
                pending={pendingDecision === "reject"}
                pendingLabel="Rejecting…"
              />
            </button>
          </>
        )}
        <DestructiveConfirmationDialog
          actionLabel="Forget memory"
          description="Wallie will remove the stored note and stop using it in future runs. Earlier approval and revision receipts remain visible."
          errorMessage={action.message?.kind === "error" ? action.message.text : null}
          onConfirm={() => void action.run({ action: "forget", ...expected })}
          onOpenChange={action.setConfirm}
          open={action.confirm}
          pending={action.isBusy}
          pendingLabel="Forgetting…"
          title="Forget this memory?"
          trigger={
            <button className="ui-button" disabled={action.isBusy} type="button">
              Forget memory
            </button>
          }
        />
      </div>
      <form onSubmit={submit}>
        <fieldset className="min-w-0 space-y-4" aria-busy={action.isBusy} disabled={action.isBusy}>
          <legend className="type-label mb-3">Propose a correction or change expiry</legend>
          <label className="block space-y-1.5">
            <span className="type-label">Memory note</span>
            <textarea
              className="ui-textarea w-full"
              rows={5}
              name="body"
              defaultValue={body ?? ""}
              maxLength={4096}
              required
            />
          </label>
          <ExpiryField inputRef={expiryInput} />
          <p className="type-secondary text-muted" id="memory-correction-effect">
            Saving withdraws any current approval. The new revision can’t be used in future runs
            until it’s approved.
          </p>
          <button aria-describedby="memory-correction-effect" className="ui-button" type="submit">
            <ActionButtonLabel
              idle="Save pending revision"
              pending={action.pendingCommand?.action === "correct"}
              pendingLabel="Saving…"
            />
          </button>
        </fieldset>
      </form>
    </div>
  );
}
