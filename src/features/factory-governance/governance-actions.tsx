"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { SelectField } from "@/components/ui/select";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  createServicePrincipalSchema,
  factoryExecutionGrantCommandSchema,
} from "@/lib/factory-execution-grants/contracts";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";
import { workspaceGovernancePath } from "@/lib/routes";

type Scope = { factoryId: string; workspaceId: string; workspaceSlug: string };
type Choice = { id: string; label: string };
type Command = z.output<typeof factoryExecutionGrantCommandSchema>;

function post(endpoint: string, body: Command | z.output<typeof createServicePrincipalSchema>) {
  return fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function route(scope: Scope, resource: "service-principals" | "execution-grants") {
  return `/api/workspaces/${scope.workspaceId}/factories/${scope.factoryId}/${resource}`;
}

function ChoiceField({
  choices,
  label,
  name,
  onChange,
  selected,
}: {
  choices: Choice[];
  label: string;
  name: string;
  onChange?: (value: string) => void;
  selected?: string;
}) {
  const id = useId();
  return (
    <SelectField
      defaultValue={selected ?? ""}
      emptyOption={{ disabled: true, label: `Choose ${label.toLowerCase()}`, value: "" }}
      id={id}
      label={label}
      labelClassName="type-label text-foreground"
      name={name}
      onValueChange={onChange}
      options={choices.map(({ id: choiceId, label: choiceLabel }) => ({
        label: choiceLabel,
        value: choiceId,
      }))}
      required
      wrap
    />
  );
}

function ScopeChoices({
  choices,
  label,
  name,
  excluded,
}: {
  choices: Choice[];
  label: string;
  name: string;
  excluded?: string;
}) {
  return (
    <details className="min-w-0 rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer type-label text-foreground">{label}</summary>
      <div className="mt-2 max-h-60 space-y-2 overflow-auto py-1">
        {choices.length ? (
          choices.map(({ id, label }) => (
            <label className="flex min-w-0 items-start gap-2 text-sm text-foreground" key={id}>
              <input
                className="mt-0.5"
                disabled={excluded === id}
                name={name}
                type="checkbox"
                value={id}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
            </label>
          ))
        ) : (
          <p className="type-secondary text-muted">No options available.</p>
        )}
      </div>
    </details>
  );
}

export function CreateServicePrincipal({ scope }: { scope: Scope }) {
  const router = useRouter();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const action = useApiAction<
    { principal: { id: string } },
    [z.output<typeof createServicePrincipalSchema>]
  >({
    call: (input) => post(route(scope, "service-principals"), input),
    errorText: "Could not create the service principal.",
    onSuccess: ({ principal }) => {
      router.push(
        workspaceGovernancePath(scope.workspaceSlug, {
          factory: scope.factoryId,
          principal: principal.id,
        }),
      );
    },
    setFlashMessage: setFeedback,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const command = createServicePrincipalSchema.safeParse({
      name: fields.get("name"),
      slug: fields.get("slug"),
    });
    if (!command.success) {
      setFeedback({ kind: "error", text: "Provide a name and a lowercase hyphenated identifier." });
      return;
    }
    setFeedback(null);
    void action.run(command.data);
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={feedback} />
      <fieldset className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Service principal details</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Principal name</span>
            <input className="ui-input" maxLength={120} name="name" required />
          </label>
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Identifier</span>
            <input
              className="ui-input"
              maxLength={60}
              name="slug"
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              required
            />
          </label>
        </div>
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Create service principal"
            pending={action.isBusy}
            pendingLabel="Creating…"
          />
        </button>
      </fieldset>
    </form>
  );
}

export function ApproveGrant({
  scope,
  principals,
  repositories,
  policies,
  members,
  tools,
  selectedPrincipal,
}: {
  scope: Scope;
  principals: Choice[];
  repositories: Choice[];
  policies: Choice[];
  members: Choice[];
  tools: Choice[];
  selectedPrincipal?: string;
}) {
  const router = useRouter();
  const [writable, setWritable] = useState("");
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const action = useApiAction<{ grant: { id: string } }, [Command]>({
    call: (input) => post(route(scope, "execution-grants"), input),
    errorText: "Could not approve the execution grant.",
    onSuccess: ({ grant }) => {
      router.push(
        workspaceGovernancePath(scope.workspaceSlug, { factory: scope.factoryId, grant: grant.id }),
      );
    },
    setFlashMessage: setFeedback,
  });
  const canSubmit =
    principals.length > 0 && repositories.length > 0 && policies.length > 0 && members.length > 0;

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const expiry = new Date(String(fields.get("expiresAt") ?? ""));
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      setFeedback({ kind: "error", text: "Choose a future expiry." });
      return;
    }
    const command = factoryExecutionGrantCommandSchema.safeParse({
      action: "approve",
      servicePrincipalId: fields.get("principal"),
      writableRepositoryId: fields.get("writable"),
      readContextRepositoryIds: fields.getAll("readonly"),
      toolIds: fields.getAll("tools"),
      commandScopes: fields.getAll("commands"),
      executionPolicyRevisionId: fields.get("policy"),
      budgetPayerMemberId: fields.get("payer"),
      expiresAt: expiry.toISOString(),
    });
    if (!command.success) {
      setFeedback({
        kind: "error",
        text: "Check the grant scope. Choose up to 50 read-only repositories and 32 tool operations.",
      });
      return;
    }
    setFeedback(null);
    void action.run(command.data);
  }

  if (!canSubmit) {
    return (
      <p className="type-secondary text-muted">
        Add a service principal, writable repository, execution policy, and active budget payer to
        approve a grant.
      </p>
    );
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit}>
      <InlineActionMessage message={feedback} />
      <fieldset className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">Execution grant scope</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <ChoiceField
            choices={principals}
            label="Service principal"
            name="principal"
            selected={selectedPrincipal}
          />
          <ChoiceField
            choices={repositories}
            label="Writable repository"
            name="writable"
            onChange={setWritable}
          />
          <ChoiceField choices={policies} label="Execution policy" name="policy" />
          <ChoiceField choices={members} label="Budget payer" name="payer" />
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Expires at</span>
            <input className="ui-input" name="expiresAt" required type="datetime-local" />
          </label>
        </div>
        <ScopeChoices
          choices={repositories}
          excluded={writable}
          label="Read-only repositories"
          name="readonly"
        />
        <ScopeChoices choices={tools} label="Allowed tool operations" name="tools" />
        <ScopeChoices
          choices={Object.entries(factoryCommandLabels).map(([id, label]) => ({ id, label }))}
          label="Machine command scopes"
          name="commands"
        />
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Approve grant"
            pending={action.isBusy}
            pendingLabel="Approving…"
          />
        </button>
      </fieldset>
    </form>
  );
}

export function RevokeGrant({
  scope,
  grantId,
  version,
}: {
  scope: Scope;
  grantId: string;
  version: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const action = useApiAction<unknown, [Command]>({
    call: (input) => post(route(scope, "execution-grants"), input),
    errorText: "Could not revoke the execution grant.",
    onSuccess: () => {
      setOpen(false);
      setReason("");
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  function confirm() {
    const command = factoryExecutionGrantCommandSchema.safeParse({
      action: "revoke",
      grantId,
      expectedVersion: version,
      reason,
    });
    if (!command.success) {
      setFeedback({ kind: "error", text: "Keep the reason on one line and within 400 bytes." });
      return;
    }
    setFeedback(null);
    void action.run(command.data);
  }

  return (
    <DestructiveConfirmationDialog
      actionLabel="Revoke grant"
      description="New sessions using this grant will be blocked until an eligible definition is published."
      errorMessage={feedback?.text}
      onConfirm={confirm}
      onOpenChange={(value) => {
        setOpen(value);
        setFeedback(null);
      }}
      open={open}
      pending={action.isBusy}
      pendingLabel="Revoking…"
      title="Revoke this execution grant?"
      trigger={
        <button className="ui-button-danger" type="button">
          Revoke grant
        </button>
      }
    >
      <label className="mt-4 block min-w-0 space-y-1.5">
        <span className="type-label text-foreground">Reason (optional)</span>
        <input
          className="ui-input"
          disabled={action.isBusy}
          maxLength={400}
          onChange={(event) => setReason(event.currentTarget.value)}
          value={reason}
        />
      </label>
    </DestructiveConfirmationDialog>
  );
}
