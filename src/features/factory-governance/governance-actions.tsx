"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import type { z } from "zod";

import { ActionButtonLabel } from "@/components/ui/action-feedback";
import { DestructiveConfirmationDialog } from "@/components/ui/destructive-confirmation-dialog";
import { useToast } from "@/components/ui/toast";
import {
  GovernanceSelect,
  matchesGovernanceSearch,
  type GovernanceChoice,
} from "./governance-fields";
import { GrantScopeSummary, PolicyLimits, type GovernancePolicy } from "./governance-grant-summary";
import type { FlashMessage } from "@/features/settings/settings-types";
import { InlineActionMessage } from "@/features/settings/settings-ui";
import { useApiAction } from "@/features/settings/use-api-action";
import {
  createServicePrincipalSchema,
  factoryExecutionGrantCommandSchema,
} from "@/lib/factory-execution-grants/contracts";
import { factoryCommandLabels } from "@/lib/factory-machine-tokens/contracts";
import { workspaceGovernancePath, workspaceSettingsPath } from "@/lib/routes";

type Scope = { factoryId: string; workspaceId: string; workspaceSlug: string };
type Choice = GovernanceChoice;
type Command = z.output<typeof factoryExecutionGrantCommandSchema>;
const commandChoices = Object.entries(factoryCommandLabels).map(([id, label]) => ({ id, label }));

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
  value,
}: {
  choices: Choice[];
  label: string;
  name: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const id = useId();
  return (
    <GovernanceSelect
      choices={choices}
      emptyOption={{ disabled: true, label: `Choose ${label.toLowerCase()}`, value: "" }}
      id={id}
      label={label}
      labelClassName="type-label text-foreground"
      name={name}
      onValueChange={onChange}
      required
      search
      value={value}
      wrap
    />
  );
}

function ScopeChoices({
  choices,
  label,
  name,
  excluded,
  selected,
  onChange,
}: {
  choices: Choice[];
  label: string;
  name: string;
  excluded?: string;
  selected: string[];
  onChange: (value: string[]) => void;
}) {
  const [filter, setFilter] = useState("");
  const matched = choices.filter(({ label }) => matchesGovernanceSearch(label, filter));
  return (
    <details className="min-w-0 rounded-md border border-border px-3 py-2">
      <summary className="cursor-pointer type-label text-foreground">
        {label} · {selected.length ? `${selected.length} selected` : "None"}
      </summary>
      {choices.length > 8 && (
        <label className="mt-2 block space-y-1">
          <span className="type-secondary text-muted">Filter {label.toLowerCase()}</span>
          <input
            className="ui-input"
            onChange={(event) => setFilter(event.currentTarget.value)}
            type="search"
            value={filter}
          />
        </label>
      )}
      <div className="mt-2 max-h-60 space-y-2 overflow-auto py-1">
        {choices.length ? (
          choices.map(({ id, label }) => (
            <label
              className={`${matchesGovernanceSearch(label, filter) ? "flex" : "hidden"} min-w-0 items-start gap-2 text-sm text-foreground`}
              key={id}
            >
              <input
                checked={selected.includes(id)}
                className="mt-0.5"
                disabled={excluded === id}
                name={name}
                onChange={(event) =>
                  onChange(
                    event.currentTarget.checked
                      ? [...selected, id]
                      : selected.filter((value) => value !== id),
                  )
                }
                type="checkbox"
                value={id}
              />
              <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
            </label>
          ))
        ) : (
          <p className="type-secondary text-muted">No options available.</p>
        )}
        {choices.length > 0 && matched.length === 0 && (
          <p className="type-secondary text-muted" role="status">
            No matching options.
          </p>
        )}
      </div>
    </details>
  );
}

export function CreateServicePrincipal({ scope }: { scope: Scope }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [identifier, setIdentifier] = useState<string>();
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const hint = useId();
  const slugId = useId();
  const suggestedIdentifier = name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  const action = useApiAction<
    { principal: { id: string } },
    [z.output<typeof createServicePrincipalSchema>]
  >({
    call: async (input) => {
      const response = await post(route(scope, "service-principals"), input);
      if (response.status === 409)
        throw new Error("This identifier is already in use. Choose a different one.");
      return response;
    },
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
            <input
              className="ui-input"
              maxLength={120}
              name="name"
              onChange={(event) => setName(event.currentTarget.value)}
              required
              value={name}
            />
          </label>
          <div className="min-w-0 space-y-1.5">
            <label className="block type-label text-foreground" htmlFor={slugId}>
              Identifier
            </label>
            <input
              aria-describedby={hint}
              className="ui-input"
              id={slugId}
              maxLength={60}
              name="slug"
              onChange={(event) => setIdentifier(event.currentTarget.value)}
              pattern="[a-z0-9]+(-[a-z0-9]+)*"
              required
              value={identifier ?? suggestedIdentifier}
            />
            <span className="block type-secondary text-muted" id={hint}>
              A stable identifier for integrations, such as release-runner. Use lowercase letters,
              numbers, and hyphens.
            </span>
          </div>
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
  isOperator,
  selectedPrincipal,
}: {
  scope: Scope;
  principals: Choice[];
  repositories: Choice[];
  policies: GovernancePolicy[];
  members: Choice[];
  tools: Choice[];
  isOperator: boolean;
  selectedPrincipal?: string;
}) {
  const router = useRouter();
  const { pushToast } = useToast();
  const [principal, setPrincipal] = useState(selectedPrincipal ?? "");
  const [writable, setWritable] = useState("");
  const [policy, setPolicy] = useState("");
  const [payer, setPayer] = useState("");
  const [readOnly, setReadOnly] = useState<string[]>([]);
  const [operations, setOperations] = useState<string[]>([]);
  const [commands, setCommands] = useState<string[]>([]);
  const [expiresAt, setExpiresAt] = useState("");
  const [expiryPreview, setExpiryPreview] = useState("");
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const expiryHint = useId();
  const action = useApiAction<{ grant: { id: string } }, [Command]>({
    call: (input) => post(route(scope, "execution-grants"), input),
    errorText: "Could not approve the execution grant.",
    onSuccess: ({ grant }) => {
      pushToast({
        title: "Grant approved",
        description: "This did not publish or change the factory definition.",
        tone: "success",
      });
      router.push(
        workspaceGovernancePath(scope.workspaceSlug, {
          factory: scope.factoryId,
          grant: grant.id,
        }),
      );
    },
    setFlashMessage: setFeedback,
  });
  const canSubmit =
    principals.length > 0 && repositories.length > 0 && policies.length > 0 && members.length > 0;
  const selectedPolicy = policies.find(({ id }) => id === policy);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fields = new FormData(event.currentTarget);
    const expiry = new Date(String(fields.get("expiresAt") ?? ""));
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      setFeedback({ kind: "error", text: "Choose a future expiry." });
      return;
    }
    if (!selectedPolicy?.requirements) {
      setFeedback({
        kind: "error",
        text: "Choose an execution policy with visible budget limits.",
      });
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
      <ul className="list-disc space-y-1 pl-5 type-secondary text-muted">
        {!principals.length && (
          <li>
            <a className="underline" href="#service-principals">
              Create a service principal
            </a>{" "}
            for this factory.
          </li>
        )}
        {!repositories.length && (
          <li>
            {isOperator ? (
              <Link
                className="underline"
                href={`${workspaceSettingsPath(scope.workspaceSlug, { category: "integrations" })}#repository`}
              >
                Set up a writable repository
              </Link>
            ) : (
              "Ask a workspace owner or admin to set up a writable repository"
            )}{" "}
            for this factory.
          </li>
        )}
        {!policies.length && (
          <li>
            {isOperator ? (
              <Link
                className="underline"
                href={`${workspaceSettingsPath(scope.workspaceSlug, { category: "integrations" })}#runtime`}
              >
                Set an execution policy
              </Link>
            ) : (
              "Ask a workspace owner or admin to set an execution policy"
            )}{" "}
            in Settings → Integrations → Agent.
          </li>
        )}
        {!members.length && (
          <li>
            {isOperator ? (
              <Link
                className="underline"
                href={`${workspaceSettingsPath(scope.workspaceSlug, { category: "workspace" })}#members`}
              >
                Add or reactivate a workspace member
              </Link>
            ) : (
              "Ask a workspace owner or admin to add or reactivate a workspace member"
            )}{" "}
            to be the budget payer.
          </li>
        )}
      </ul>
    );
  }

  const choiceName = (choices: Choice[], id: string) =>
    choices.find((choice) => choice.id === id)?.label ?? "Not selected";

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
            onChange={setPrincipal}
            value={principal}
          />
          <ChoiceField
            choices={repositories}
            label="Writable repository"
            name="writable"
            onChange={(id) => {
              setWritable(id);
              setReadOnly((current) => current.filter((entry) => entry !== id));
            }}
            value={writable}
          />
          <div>
            <ChoiceField
              choices={policies}
              label="Execution policy"
              name="policy"
              onChange={setPolicy}
              value={policy}
            />
            <PolicyLimits policy={selectedPolicy} />
          </div>
          <div>
            <ChoiceField
              choices={members}
              label="Budget payer"
              name="payer"
              onChange={setPayer}
              value={payer}
            />
            <p className="type-secondary mt-1 text-muted">
              The active workspace member accountable for execution budget usage under this grant.
            </p>
          </div>
          <div className="min-w-0 space-y-1.5">
            <label className="block type-label text-foreground" htmlFor={`${expiryHint}-field`}>
              Expires at
            </label>
            <input
              aria-describedby={expiryHint}
              className="ui-input"
              id={`${expiryHint}-field`}
              name="expiresAt"
              onChange={(event) => {
                const value = event.currentTarget.value;
                setExpiresAt(value);
                const date = new Date(value);
                setExpiryPreview(
                  Number.isFinite(date.getTime())
                    ? new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "long",
                      }).format(date)
                    : "",
                );
              }}
              required
              type="datetime-local"
              value={expiresAt}
            />
            <p className="type-secondary text-muted" id={expiryHint}>
              Uses your local time zone.
            </p>
          </div>
        </div>
        <ScopeChoices
          choices={repositories}
          excluded={writable}
          label="Read-only repositories"
          name="readonly"
          onChange={setReadOnly}
          selected={readOnly}
        />
        <ScopeChoices
          choices={tools}
          label="Allowed tool operations"
          name="tools"
          onChange={setOperations}
          selected={operations}
        />
        <ScopeChoices
          choices={commandChoices}
          label="Machine command scopes"
          name="commands"
          onChange={setCommands}
          selected={commands}
        />
        <div className="space-y-2 border-t border-border pt-4">
          <h3 className="type-label text-foreground">Review grant permissions</h3>
          <GrantScopeSummary
            commands={commands.map((id) => choiceName(commandChoices, id))}
            expires={expiryPreview || "Not selected"}
            payer={choiceName(members, payer)}
            policy={selectedPolicy}
            principal={choiceName(principals, principal)}
            readOnly={readOnly.map((id) => choiceName(repositories, id))}
            tools={operations.map((id) => choiceName(tools, id))}
            writable={choiceName(repositories, writable)}
          />
          {!commands.length && (
            <p className="type-secondary text-muted">
              Without machine command scopes, this grant cannot back machine tokens or OAuth
              clients.
            </p>
          )}
          <p className="type-secondary text-muted">
            Approving a grant does not publish or change the factory definition.
          </p>
        </div>
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
  target,
  pinned,
  dependencies,
}: {
  scope: Scope;
  grantId: string;
  version: number;
  target: string;
  pinned: boolean;
  dependencies: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [feedback, setFeedback] = useState<FlashMessage | null>(null);
  const [stale, setStale] = useState(false);
  const action = useApiAction<unknown, [Command]>({
    call: async (input) => {
      const response = await post(route(scope, "execution-grants"), input);
      if (response.status === 409) setStale(true);
      return response;
    },
    errorText: "Could not revoke the execution grant.",
    onSuccess: () => {
      setOpen(false);
      setReason("");
      router.refresh();
    },
    setFlashMessage: setFeedback,
  });

  function confirm() {
    if (stale) return;
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
      actionDisabled={stale}
      actionLabel="Revoke grant"
      description={`This revokes v${version} for ${target}. Credentials using this version can no longer authorize requests.`}
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
      <div className="mt-3 space-y-2 type-secondary text-muted [overflow-wrap:anywhere]">
        {pinned && (
          <p className="font-medium text-foreground">
            The published definition uses this version. New sessions and queued attempts using it
            will be blocked until an eligible definition is published.
          </p>
        )}
        <p>
          Dependent machine tokens, OAuth factory access, and event subscriptions can stop working.
          Revocation can’t be undone.
        </p>
        {dependencies.length > 0 && <p>Visible dependencies: {dependencies.join("; ")}.</p>}
      </div>
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
      {stale && (
        <button className="ui-button mt-3" onClick={() => window.location.reload()} type="button">
          Reload and review
        </button>
      )}
    </DestructiveConfirmationDialog>
  );
}
