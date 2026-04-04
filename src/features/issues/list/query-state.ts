import type { Json } from "@/lib/supabase/database.types";
import type {
  IssueEstimateValue,
  IssueListPreferences,
  IssuePriority,
  IssueSortField,
  IssueStatus,
  SortDirection,
} from "@/features/issues/types";
import {
  ISSUE_ESTIMATE_VALUES,
  ISSUE_PRIORITY_VALUES,
  ISSUE_SORT_FIELDS,
  ISSUE_STATUS_VALUES,
} from "@/features/issues/types";

type SearchParamInput = Record<string, string | string[] | undefined> | URLSearchParams;

export type IssueListQueryState = {
  direction: SortDirection;
  estimates: IssueEstimateValue[];
  priorities: IssuePriority[];
  query: string;
  sort: IssueSortField;
  statuses: IssueStatus[];
};

const defaultIssueListQueryState: IssueListQueryState = {
  direction: "desc",
  estimates: [],
  priorities: [],
  query: "",
  sort: "updated",
  statuses: [],
};

function isRecord(value: Json | null | undefined): value is Record<string, Json | undefined> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readParamValues(input: SearchParamInput, key: string) {
  if (input instanceof URLSearchParams) {
    return input.getAll(key);
  }

  const value = input[key];

  if (Array.isArray(value)) {
    return value;
  }

  return value ? [value] : [];
}

function splitParamValues(input: SearchParamInput, key: string) {
  return readParamValues(input, key)
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function uniqueValues<T>(values: readonly T[]) {
  return Array.from(new Set(values));
}

function parseSortField(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  return ISSUE_SORT_FIELDS.find((field) => field === value);
}

function parseDirection(value: string | undefined) {
  return value === "asc" || value === "desc" ? value : undefined;
}

export function readIssueListPreferences(value: Json | null | undefined): IssueListPreferences {
  if (!isRecord(value)) {
    return {};
  }

  const issues = value.issues;

  if (!isRecord(issues)) {
    return {};
  }

  const sort = parseSortField(typeof issues.sort === "string" ? issues.sort : undefined);
  const direction = parseDirection(
    typeof issues.direction === "string" ? issues.direction : undefined,
  );

  return {
    direction,
    sort,
  };
}

export function mergeIssueListPreferences(
  value: Json | null | undefined,
  nextPreferences: IssueListPreferences,
): Json {
  const root = isRecord(value) ? { ...value } : {};
  const issues = isRecord(root.issues) ? { ...root.issues } : {};

  if (nextPreferences.sort) {
    issues.sort = nextPreferences.sort;
  }

  if (nextPreferences.direction) {
    issues.direction = nextPreferences.direction;
  }

  root.issues = issues;

  return root;
}

export function parseIssueListQueryState(
  input: SearchParamInput,
  preferences: IssueListPreferences = {},
): IssueListQueryState {
  const sort =
    parseSortField(readParamValues(input, "sort")[0] ?? readParamValues(input, "orderBy")[0]) ??
    preferences.sort ??
    defaultIssueListQueryState.sort;
  const direction =
    parseDirection(
      readParamValues(input, "direction")[0] ?? readParamValues(input, "orderDirection")[0],
    ) ??
    preferences.direction ??
    defaultIssueListQueryState.direction;
  const statuses = uniqueValues(
    splitParamValues(input, "status").filter((value): value is IssueStatus =>
      ISSUE_STATUS_VALUES.includes(value as IssueStatus),
    ),
  );
  const priorities = uniqueValues(
    splitParamValues(input, "priority").filter((value): value is IssuePriority =>
      ISSUE_PRIORITY_VALUES.includes(value as IssuePriority),
    ),
  );
  const estimates = uniqueValues(
    splitParamValues(input, "estimate").flatMap((value) => {
      if (value === "null") {
        return [null];
      }

      const parsed = Number(value);

      return Number.isInteger(parsed) &&
        ISSUE_ESTIMATE_VALUES.includes(parsed as IssueEstimateValue)
        ? [parsed as IssueEstimateValue]
        : [];
    }),
  );
  const query = (readParamValues(input, "query")[0] ?? "").trim();

  return {
    direction,
    estimates,
    priorities,
    query,
    sort,
    statuses,
  };
}

export function serializeIssueListQueryState(
  state: IssueListQueryState,
  defaults: IssueListQueryState = defaultIssueListQueryState,
) {
  const params = new URLSearchParams();

  if (state.query) {
    params.set("query", state.query);
  }

  if (state.statuses.length > 0) {
    params.set("status", state.statuses.join(","));
  }

  if (state.priorities.length > 0) {
    params.set("priority", state.priorities.join(","));
  }

  if (state.estimates.length > 0) {
    params.set(
      "estimate",
      state.estimates.map((estimate) => (estimate === null ? "null" : String(estimate))).join(","),
    );
  }

  if (state.sort !== defaults.sort) {
    params.set("sort", state.sort);
  }

  if (state.direction !== defaults.direction) {
    params.set("direction", state.direction);
  }

  return params;
}

export { defaultIssueListQueryState };
export type { SearchParamInput };
