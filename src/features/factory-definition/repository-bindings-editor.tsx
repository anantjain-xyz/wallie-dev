import type { SerialFactoryDefinition } from "@/lib/factory-definitions/schema";
import { normalizeFactoryId } from "@/lib/factory-definitions/references";

type RepositoryOption = { id: string; fullName: string; isArchived: boolean };
type RepositoryField = "repository" | "writableRepositories" | "readContextRepositories";
type Bindings = Pick<SerialFactoryDefinition, RepositoryField>;

function RepositoryBindingList({
  label,
  addLabel,
  available,
  selected,
  onChange,
}: {
  label: string;
  addLabel: string;
  available: readonly RepositoryOption[];
  selected: { value: string; label: string }[];
  onChange: (values: string[]) => void;
}) {
  return (
    <div className="min-w-0 space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-[13px] font-medium text-foreground">{label}</span>
        <select
          className="ui-select"
          disabled={available.length === 0}
          onChange={(event) => {
            if (!event.target.value) return;
            onChange([...selected.map(({ value }) => value), event.target.value]);
          }}
          value=""
        >
          <option value="">{available.length > 0 ? addLabel : "No unassigned repositories"}</option>
          {available.map(({ id, fullName }) => (
            <option key={id} value={id}>
              {fullName}
            </option>
          ))}
        </select>
      </label>
      {selected.length > 0 && (
        <ul className="space-y-1.5" aria-label={label}>
          {selected.map(({ value, label: name }, index) => (
            <li
              className="flex items-center justify-between gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm"
              key={`${value}-${index}`}
            >
              <span className="min-w-0 break-all">{name}</span>
              <button
                aria-label={`Remove ${name} from ${label.toLowerCase()}`}
                className="ui-button min-h-8 shrink-0 px-2 py-1"
                onClick={() =>
                  onChange(
                    selected.flatMap((item, current) => (index === current ? [] : item.value)),
                  )
                }
                type="button"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function FactoryRepositoryBindingsEditor({
  value,
  repositories,
  onChange,
}: {
  value: Bindings;
  repositories: readonly RepositoryOption[];
  onChange: (patch: Partial<Bindings>) => void;
}) {
  function repositoryFor(reference: string) {
    return repositories.find(
      ({ id, fullName }) => id === normalizeFactoryId(reference) || fullName === reference,
    );
  }

  function toSelected(reference: string) {
    const repo = repositoryFor(reference);
    const name = repo?.fullName ?? reference;
    return { value: reference, label: !repo || repo.isArchived ? `${name} (unavailable)` : name };
  }

  const { repository, writableRepositories = [], readContextRepositories = [] } = value;
  const defaultRepo = repositoryFor(repository);
  const assignedAlternatives = new Set(
    [...writableRepositories, ...readContextRepositories].map(
      (reference) => repositoryFor(reference)?.id,
    ),
  );
  const unassigned = repositories.filter(
    ({ id, isArchived }) => !isArchived && id !== defaultRepo?.id && !assignedAlternatives.has(id),
  );

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="block min-w-0 space-y-1.5 sm:col-span-2">
        <span className="text-[13px] font-medium text-foreground">Default writable repository</span>
        <select
          className="ui-select"
          onChange={(event) => onChange({ repository: event.target.value })}
          value={repository}
        >
          <option value={repository}>{toSelected(repository).label}</option>
          {unassigned.map(({ id, fullName }) => (
            <option key={id} value={id}>
              {fullName}
            </option>
          ))}
        </select>
      </label>
      <RepositoryBindingList
        addLabel="Add writable repository…"
        available={unassigned}
        label="Other writable repositories"
        onChange={(values) =>
          onChange({ writableRepositories: values.length ? values : undefined })
        }
        selected={writableRepositories.map(toSelected)}
      />
      <RepositoryBindingList
        addLabel="Add context repository…"
        available={unassigned}
        label="Read-only context repositories"
        onChange={(values) =>
          onChange({ readContextRepositories: values.length ? values : undefined })
        }
        selected={readContextRepositories.map(toSelected)}
      />
      <p className="type-annotation text-muted sm:col-span-2">
        Each session uses one writable repository. Context repositories are available for reading.
      </p>
    </div>
  );
}
