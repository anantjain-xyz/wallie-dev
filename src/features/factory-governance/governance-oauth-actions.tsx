"use client";

import { useRouter } from "next/navigation";
import { useId, useRef, useState, type FormEvent } from "react";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { GovernanceSelect } from "./governance-fields";
import type { GovernanceOAuthData } from "@/features/factory-governance/governance-oauth-data";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  factoryCommandLabels,
  factoryCommandScopeSchema,
} from "@/lib/factory-machine-tokens/contracts";
import {
  registerFactoryOAuthClientSchema,
  type FactoryOAuthManagementCommand,
} from "@/lib/factory-oauth/management-contracts";

function post(workspaceId: string, command: FactoryOAuthManagementCommand) {
  return fetch(`/api/workspaces/${workspaceId}/oauth-clients`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(command),
  });
}

export function RegisterOAuthClient({
  options,
  workspaceId,
}: {
  options: GovernanceOAuthData["grantOptions"];
  workspaceId: string;
}) {
  const router = useRouter();
  const form = useRef<HTMLFormElement>(null);
  const redirectHint = useId();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [selection, setSelection] = useState<Record<string, string>>({});
  const selected = options.flatMap((factory) => {
    const grant = factory.choices.find((choice) => choice.id === selection[factory.id]);
    return grant ? [{ factory, grant }] : [];
  });
  const action = useApiAction<{ client: { id: string } }, [FactoryOAuthManagementCommand]>({
    call: (command) => post(workspaceId, command),
    errorText: "Could not register the OAuth client.",
    successText: "OAuth client registered.",
    onSuccess: () => {
      setSelection({});
      form.current?.reset();
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const command = registerFactoryOAuthClientSchema.safeParse({
      action: "register",
      name: fields.get("name"),
      redirectUris: String(fields.get("redirectUris") ?? "")
        .split(/\r?\n/)
        .map((uri) => uri.trim())
        .filter(Boolean),
      scopes: fields.getAll("scope"),
      bindings: selected.map(({ factory, grant }) => ({
        factoryId: factory.id,
        executionGrantId: grant.id,
        executionGrantVersion: grant.version,
      })),
    });
    if (!command.success) {
      setFeedback({
        kind: "error",
        text: "Enter a name, up to 10 exact redirect URIs, and approved scopes for the selected factories.",
      });
      return;
    }
    const { scopes } = command.data;
    if (selected.some(({ grant }) => !grant.scopes.some((scope) => scopes.includes(scope)))) {
      setFeedback({
        kind: "error",
        text: "Choose at least one approved scope for each selected factory.",
      });
      return;
    }
    setFeedback(null);
    void action.run(command.data);
  }

  if (!options.length) {
    return (
      <p className="type-secondary text-muted">
        Approve an execution grant with a machine command scope to register a client.
      </p>
    );
  }

  return (
    <form className="ui-sheet min-w-0 space-y-4 p-4 sm:p-5" onSubmit={submit} ref={form}>
      <InlineActionMessage message={feedback} />
      <fieldset className="min-w-0 space-y-4" disabled={action.isBusy}>
        <legend className="sr-only">OAuth client registration</legend>
        <label className="block min-w-0 space-y-1.5">
          <span className="type-label text-foreground">Client name</span>
          <input className="ui-input" name="name" maxLength={120} required />
        </label>
        <div className="min-w-0 space-y-1.5">
          <label className="block min-w-0 space-y-1.5">
            <span className="type-label text-foreground">Redirect URIs</span>
            <textarea
              aria-describedby={redirectHint}
              className="ui-input min-h-20"
              name="redirectUris"
              rows={3}
              required
            />
          </label>
          <p className="type-secondary text-muted" id={redirectHint}>
            One exact URI per line.
          </p>
        </div>
        <fieldset className="grid min-w-0 gap-3 sm:grid-cols-2">
          <legend className="type-label mb-2 text-foreground">Factory execution grants</legend>
          {options.map((factory) => (
            <GovernanceSelect
              choices={factory.choices}
              emptyOption={{ label: "No access", value: "" }}
              key={factory.id}
              label={`${factory.name} execution grant`}
              labelClassName="type-label text-foreground [overflow-wrap:anywhere]"
              onValueChange={(value) => {
                setSelection((current) => ({ ...current, [factory.id]: value }));
              }}
              search
              value={selection[factory.id] ?? ""}
              wrap
            />
          ))}
        </fieldset>
        <fieldset className="min-w-0 space-y-2">
          <legend className="type-label text-foreground">Command scopes</legend>
          {factoryCommandScopeSchema.options.map((scope) => (
            <label className="flex items-start gap-2 text-sm text-foreground" key={scope}>
              <input
                className="mt-0.5"
                disabled={!selected.some(({ grant }) => grant.scopes.includes(scope))}
                name="scope"
                type="checkbox"
                value={scope}
              />
              {factoryCommandLabels[scope]}
            </label>
          ))}
        </fieldset>
        <button className="ui-button ui-button-primary" type="submit">
          <ActionButtonLabel
            idle="Register OAuth client"
            pending={action.isBusy}
            pendingLabel="Registering…"
          />
        </button>
      </fieldset>
    </form>
  );
}

export function RevokeOAuthAccess({
  command,
  factories,
  name,
  workspaceId,
}: {
  command: Exclude<FactoryOAuthManagementCommand, { action: "register" }>;
  factories?: string[];
  name: string;
  workspaceId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const registration = command.action === "revoke-client";
  const label = registration ? "Revoke client" : "Disconnect client";
  const action = useApiAction<{ revoked: true }>({
    call: () => post(workspaceId, command),
    errorText: "Could not revoke this OAuth access.",
    onSuccess: () => {
      setOpen(false);
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  return (
    <DestructiveConfirmationDialog
      actionLabel={label}
      description={
        registration
          ? "This revokes the workspace registration and all its connections across every linked factory, regardless of the selected factory."
          : factories
            ? "This connection will lose read and command access across all of its authorized factories."
            : "This connection will lose read and command access."
      }
      errorMessage={feedback?.text}
      onConfirm={() => void action.run()}
      onOpenChange={(value) => {
        setOpen(value);
        setFeedback(null);
      }}
      open={open}
      pending={action.isBusy}
      pendingLabel={registration ? "Revoking…" : "Disconnecting…"}
      title={`${registration ? "Revoke" : "Disconnect"} ${name}?`}
      trigger={
        <button className="ui-button-danger" type="button">
          {label}
        </button>
      }
    >
      {factories?.length ? (
        <p className="mt-3 type-secondary text-muted [overflow-wrap:anywhere]">
          Affected factories: {factories.join(", ")}.
        </p>
      ) : null}
    </DestructiveConfirmationDialog>
  );
}
