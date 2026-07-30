import { createHash } from "node:crypto";
import { createRequire } from "node:module";

import type { ParseResult, RawStmt } from "@pgsql/parser/v17";

export type MigrationFiles = Readonly<Record<string, string>>;

export type MigrationSafetyIssueCode =
  | "backdated-migration"
  | "historical-migration-edited"
  | "historical-migration-deleted"
  | "historical-migration-renamed"
  | "invalid-waiver"
  | "sql-parse-error"
  | "unauthorized-waiver-owner"
  | "unsupported-ddl"
  | "unused-waiver"
  | "unwaived-operation";

export interface MigrationSafetyIssue {
  code: MigrationSafetyIssueCode;
  file: string;
  line?: number;
  message: string;
}

export interface VerifyMigrationSafetyOptions {
  baseMigrations: MigrationFiles;
  currentMigrations: MigrationFiles;
  waiverOwners: readonly string[];
}

interface Operation {
  key: string;
  description: string;
}

interface ParsedWaiver {
  key: string;
  owner: string;
  issue: string;
  line: number;
  consumed: boolean;
}

interface StatementAnalysis {
  operations: Operation[];
  unsupported?: string;
}

type FunctionSecurityMode = "security-definer" | "security-invoker";

interface MigrationAnalysisContext {
  createdFunctionSecurityModes: Map<string, FunctionSecurityMode>;
}

type AstRecord = Record<string, unknown>;

const require = createRequire(import.meta.url);
const postgresParser = (
  require("@pgsql/parser") as {
    v17: { parse(sql: string): Promise<ParseResult> };
  }
).v17;

const WAIVER_PREFIX = "-- wallie-migration-safety:";
const WAIVER_PATTERN =
  /^-- wallie-migration-safety:\s+allow\s+(.+?)\s+owner=(@[A-Za-z0-9][A-Za-z0-9-]*)\s+issue=([A-Z][A-Z0-9]+-\d+)\s*$/;

const SAFE_STATEMENTS = new Set([
  "CommentStmt",
  "CompositeTypeStmt",
  "CreateDomainStmt",
  "CreateEnumStmt",
  "CreateExtensionStmt",
  "CreateSchemaStmt",
  "CreateSeqStmt",
  "CreateStatsStmt",
  "CreateStmt",
  "CreateTableAsStmt",
  "InsertStmt",
  "MergeStmt",
  "RefreshMatViewStmt",
  "SecLabelStmt",
  "TransactionStmt",
  "VariableSetStmt",
]);

const SAFE_ALTER_TABLE_COMMANDS = new Set([
  "AT_AddIndex",
  "AT_AttachPartition",
  "AT_CheckNotNull",
  "AT_ChangeOwner",
  "AT_ClusterOn",
  "AT_CookedColumnDefault",
  "AT_DropCluster",
  "AT_DropNotNull",
  "AT_EnableRule",
  "AT_GenericOptions",
  "AT_NoForceRowSecurity",
  "AT_ResetOptions",
  "AT_ResetRelOptions",
  "AT_SetCompression",
  "AT_SetLogged",
  "AT_SetOptions",
  "AT_SetRelOptions",
  "AT_SetStatistics",
  "AT_SetStorage",
  "AT_SetTableSpace",
  "AT_ValidateConstraint",
]);

const CONTRACTING_ALTER_TABLE_COMMANDS = new Set([
  "AT_AddColumnToView",
  "AT_AddConstraint",
  "AT_AddIdentity",
  "AT_AddIndexConstraint",
  "AT_AddInherit",
  "AT_AddOf",
  "AT_AlterColumnGenericOptions",
  "AT_AlterColumnType",
  "AT_AlterConstraint",
  "AT_DetachPartition",
  "AT_DetachPartitionFinalize",
  "AT_DisableRowSecurity",
  "AT_DisableRule",
  "AT_DisableTrig",
  "AT_DisableTrigAll",
  "AT_DisableTrigUser",
  "AT_DropColumn",
  "AT_DropConstraint",
  "AT_DropExpression",
  "AT_DropIdentity",
  "AT_DropInherit",
  "AT_DropOf",
  "AT_EnableRowSecurity",
  "AT_EnableAlwaysRule",
  "AT_EnableAlwaysTrig",
  "AT_EnableTrig",
  "AT_EnableTrigAll",
  "AT_EnableTrigUser",
  "AT_EnableReplicaRule",
  "AT_EnableReplicaTrig",
  "AT_ForceRowSecurity",
  "AT_ReplicaIdentity",
  "AT_SetAccessMethod",
  "AT_SetExpression",
  "AT_SetIdentity",
  "AT_SetNotNull",
  "AT_SetUnLogged",
]);

function isRecord(value: unknown): value is AstRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeVariant(node: unknown): [string, AstRecord] | undefined {
  if (!isRecord(node)) return undefined;

  const entries = Object.entries(node);
  if (entries.length !== 1 || !isRecord(entries[0][1])) return undefined;

  return [entries[0][0], entries[0][1]];
}

function containsNodeVariant(value: unknown, kind: string): boolean {
  const variant = nodeVariant(value);
  if (variant?.[0] === kind) return true;

  if (Array.isArray(value)) {
    return value.some((item) => containsNodeVariant(item, kind));
  }

  return isRecord(value) && Object.values(value).some((item) => containsNodeVariant(item, kind));
}

function stringNode(node: unknown): string | undefined {
  const variant = nodeVariant(node);
  if (variant?.[0] !== "String") return undefined;

  return typeof variant[1].sval === "string" ? variant[1].sval : undefined;
}

function quotedIdentifier(identifier: string): string {
  return JSON.stringify(identifier);
}

function canonicalName(nodes: unknown): string | undefined {
  if (!Array.isArray(nodes)) return undefined;

  const parts = nodes.map(stringNode);
  if (parts.some((part) => part === undefined)) return undefined;

  return (parts as string[]).map(quotedIdentifier).join(".");
}

function canonicalRangeVar(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.relname !== "string") return undefined;

  const parts = [
    typeof value.catalogname === "string" ? value.catalogname : undefined,
    typeof value.schemaname === "string" ? value.schemaname : undefined,
    value.relname,
  ].filter((part): part is string => part !== undefined);

  return parts.map(quotedIdentifier).join(".");
}

function canonicalType(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;

  const name = canonicalName(value.names);
  if (!name) return undefined;

  const arrayDepth = Array.isArray(value.arrayBounds) ? value.arrayBounds.length : 0;
  return `${name}${"[]".repeat(arrayDepth)}`;
}

function canonicalObjectWithArgs(value: AstRecord): string | undefined {
  const name = canonicalName(value.objname);
  if (!name) return undefined;

  const args = Array.isArray(value.objargs)
    ? value.objargs.map((node) => {
        const variant = nodeVariant(node);
        return variant?.[0] === "TypeName" ? canonicalType(variant[1]) : undefined;
      })
    : [];

  if (args.some((arg) => arg === undefined)) return undefined;
  return `${name}(${args.join(",")})`;
}

function canonicalFunctionIdentity(statement: AstRecord): string | undefined {
  const name = canonicalName(statement.funcname);
  if (!name) return undefined;

  const parameters = Array.isArray(statement.parameters) ? statement.parameters : [];
  const inputTypes: string[] = [];

  for (const node of parameters) {
    const variant = nodeVariant(node);
    if (variant?.[0] !== "FunctionParameter") return undefined;

    const mode = variant[1].mode;
    if (mode === "FUNC_PARAM_OUT" || mode === "FUNC_PARAM_TABLE") continue;

    const type = canonicalType(variant[1].argType);
    if (!type) return undefined;
    inputTypes.push(type);
  }

  return `${name}(${inputTypes.join(",")})`;
}

function functionSecurityMode(statement: AstRecord): FunctionSecurityMode {
  if (!Array.isArray(statement.options)) return "security-invoker";

  const securityOption = statement.options.find((node) => {
    const variant = nodeVariant(node);
    return variant?.[0] === "DefElem" && variant[1].defname === "security";
  });
  const variant = nodeVariant(securityOption);
  const value = variant?.[0] === "DefElem" ? nodeVariant(variant[1].arg) : undefined;

  return value?.[0] === "Boolean" && value[1].boolval === true
    ? "security-definer"
    : "security-invoker";
}

function canonicalObject(node: unknown): string | undefined {
  const variant = nodeVariant(node);
  if (!variant) return undefined;

  if (variant[0] === "List" && Array.isArray(variant[1].items)) {
    return canonicalName(variant[1].items);
  }

  if (variant[0] === "ObjectWithArgs") {
    return canonicalObjectWithArgs(variant[1]);
  }

  if (variant[0] === "String") {
    return typeof variant[1].sval === "string" ? quotedIdentifier(variant[1].sval) : undefined;
  }

  return undefined;
}

function objectLabel(objectType: unknown): string | undefined {
  if (typeof objectType !== "string" || !objectType.startsWith("OBJECT_")) return undefined;
  return objectType.slice("OBJECT_".length).toLowerCase().replaceAll("_", "-");
}

function commandLabel(subtype: string): string {
  return subtype
    .replace(/^AT_/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase();
}

function canonicalAstValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalAstValue);
  if (!isRecord(value)) return typeof value === "bigint" ? value.toString() : value;

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => key !== "location" && key !== "stmt_location" && key !== "stmt_len")
      .sort()
      .map((key) => [key, canonicalAstValue(value[key])]),
  );
}

function canonicalAstDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalAstValue(value)))
    .digest("hex")
    .slice(0, 16);
}

function relationMember(relation: string, member: unknown): string {
  return typeof member === "string" ? `${relation}.${quotedIdentifier(member)}` : relation;
}

function operation(key: string, description: string): Operation {
  return { key, description };
}

function classifyDrop(statement: AstRecord): StatementAnalysis {
  const label = objectLabel(statement.removeType);
  if (!label || !Array.isArray(statement.objects)) {
    return { operations: [], unsupported: "DROP has an unsupported object identity" };
  }
  if (statement.behavior !== "DROP_RESTRICT" && statement.behavior !== "DROP_CASCADE") {
    return { operations: [], unsupported: `DROP ${label} has an unknown drop behavior` };
  }

  const identities = statement.objects.map(canonicalObject);
  if (identities.some((identity) => identity === undefined)) {
    return {
      operations: [],
      unsupported: `DROP ${label} has an unsupported PostgreSQL AST object shape`,
    };
  }

  return {
    operations: (identities as string[]).map((identity) =>
      operation(
        `drop-${label}:${identity}${statement.behavior === "DROP_CASCADE" ? ":cascade" : ""}`,
        `DROP ${label} ${identity}${statement.behavior === "DROP_CASCADE" ? " CASCADE" : ""}`,
      ),
    ),
  };
}

function classifyRename(statement: AstRecord): StatementAnalysis {
  const label = objectLabel(statement.renameType);
  if (!label || typeof statement.newname !== "string") {
    return { operations: [], unsupported: "RENAME has an unsupported object identity" };
  }

  const relation = canonicalRangeVar(statement.relation);
  const object = canonicalObject(statement.object);
  const source = relation
    ? relationMember(relation, statement.subname)
    : object
      ? typeof statement.subname === "string"
        ? `${object}.${quotedIdentifier(statement.subname)}`
        : object
      : undefined;

  if (!source) {
    return {
      operations: [],
      unsupported: `RENAME ${label} has an unsupported PostgreSQL AST object shape`,
    };
  }

  const target = quotedIdentifier(statement.newname);
  return {
    operations: [
      operation(`rename-${label}:${source}->${target}`, `RENAME ${label} ${source} to ${target}`),
    ],
  };
}

function columnDef(command: AstRecord): AstRecord | undefined {
  const variant = nodeVariant(command.def);
  return variant?.[0] === "ColumnDef" ? variant[1] : undefined;
}

function columnIsNotNull(definition: AstRecord): boolean {
  if (!Array.isArray(definition.constraints)) return false;

  return definition.constraints.some((constraint) => {
    const variant = nodeVariant(constraint);
    return (
      variant?.[0] === "Constraint" &&
      (variant[1].contype === "CONSTR_NOTNULL" || variant[1].contype === "CONSTR_PRIMARY")
    );
  });
}

function alterTableOperation(
  subtype: string,
  relation: string,
  command: AstRecord,
): Operation | undefined {
  let memberName = command.name;

  if (subtype === "AT_AddConstraint") {
    const definition = nodeVariant(command.def);
    if (definition?.[0] !== "Constraint") return undefined;

    memberName =
      typeof definition[1].conname === "string"
        ? definition[1].conname
        : `unnamed-${String(definition[1].contype ?? "constraint").toLowerCase()}-${canonicalAstDigest(
            definition[1],
          )}`;
  } else if (subtype === "AT_AddColumnToView") {
    memberName = columnDef(command)?.colname;
  }

  const member =
    typeof memberName === "string"
      ? relationMember(relation, memberName)
      : command.def === undefined
        ? relation
        : `${relation}:ast-${canonicalAstDigest(command.def)}`;

  if (subtype === "AT_DropColumn") {
    return operation(`drop-column:${member}`, `DROP column ${member}`);
  }

  if (subtype === "AT_DropConstraint") {
    return operation(`drop-constraint:${member}`, `DROP constraint ${member}`);
  }

  if (subtype === "AT_AlterColumnType") {
    const definition = columnDef(command);
    const type = definition ? canonicalType(definition.typeName) : undefined;
    if (!type) return undefined;
    return operation(
      `alter-column-type:${member}->${type}`,
      `change the type of column ${member} to ${type}`,
    );
  }

  return operation(
    `alter-table-${commandLabel(subtype)}:${member}`,
    `${commandLabel(subtype)} on ${member}`,
  );
}

function classifyAlterTable(statement: AstRecord): StatementAnalysis {
  const relation = canonicalRangeVar(statement.relation);
  if (!relation || !Array.isArray(statement.cmds)) {
    return {
      operations: [],
      unsupported: "ALTER TABLE has an unsupported relation or command list",
    };
  }

  const operations: Operation[] = [];

  for (const node of statement.cmds) {
    const variant = nodeVariant(node);
    if (variant?.[0] !== "AlterTableCmd" || typeof variant[1].subtype !== "string") {
      return { operations: [], unsupported: "ALTER TABLE contains an unknown command shape" };
    }

    const command = variant[1];
    const subtype = command.subtype as string;

    if (subtype === "AT_AddColumn") {
      const definition = columnDef(command);
      if (!definition || typeof definition.colname !== "string") {
        return { operations: [], unsupported: "ADD COLUMN has an unknown column definition" };
      }

      if (columnIsNotNull(definition)) {
        const member = relationMember(relation, definition.colname);
        operations.push(
          operation(`add-not-null-column:${member}`, `add NOT NULL column ${member}`),
        );
      }
      continue;
    }

    if (subtype === "AT_ColumnDefault") {
      if (command.def === undefined) {
        const member = relationMember(relation, command.name);
        operations.push(
          operation(`drop-column-default:${member}`, `drop the default for column ${member}`),
        );
      }
      continue;
    }

    if (SAFE_ALTER_TABLE_COMMANDS.has(subtype)) continue;

    if (CONTRACTING_ALTER_TABLE_COMMANDS.has(subtype)) {
      const classified = alterTableOperation(subtype, relation, command);
      if (!classified) {
        return {
          operations: [],
          unsupported: `ALTER TABLE ${subtype} has an unsupported PostgreSQL AST shape`,
        };
      }
      operations.push(classified);
      continue;
    }

    return {
      operations: [],
      unsupported: `ALTER TABLE command ${subtype} is outside the supported migration subset`,
    };
  }

  return { operations };
}

function classifyTruncate(statement: AstRecord): StatementAnalysis {
  if (!Array.isArray(statement.relations)) {
    return { operations: [], unsupported: "TRUNCATE has an unsupported relation list" };
  }

  const relations = statement.relations.map((node) => {
    const variant = nodeVariant(node);
    return variant?.[0] === "RangeVar" ? canonicalRangeVar(variant[1]) : undefined;
  });

  if (relations.some((relation) => relation === undefined)) {
    return { operations: [], unsupported: "TRUNCATE has an unsupported relation identity" };
  }

  return {
    operations: (relations as string[]).map((relation) =>
      operation(`truncate-table:${relation}`, `TRUNCATE table ${relation}`),
    ),
  };
}

function classifyDelete(statement: AstRecord): StatementAnalysis {
  const relation = canonicalRangeVar(statement.relation);
  if (!relation) {
    return { operations: [], unsupported: "DELETE has an unsupported relation identity" };
  }

  return statement.whereClause === undefined
    ? {
        operations: [
          operation(`delete-all-rows:${relation}`, `DELETE every row from table ${relation}`),
        ],
      }
    : { operations: [] };
}

function classifyUpdate(statement: AstRecord): StatementAnalysis {
  const relation = canonicalRangeVar(statement.relation);
  if (!relation) {
    return { operations: [], unsupported: "UPDATE has an unsupported relation identity" };
  }

  return statement.whereClause === undefined
    ? {
        operations: [
          operation(
            `update-all-rows:${relation}:ast-${canonicalAstDigest({
              fromClause: statement.fromClause,
              targetList: statement.targetList,
              withClause: statement.withClause,
            })}`,
            `UPDATE every row in table ${relation}`,
          ),
        ],
      }
    : { operations: [] };
}

function classifyIndex(statement: AstRecord): StatementAnalysis {
  if (statement.unique !== true) return { operations: [] };

  const relation = canonicalRangeVar(statement.relation);
  if (!relation || (statement.idxname !== undefined && typeof statement.idxname !== "string")) {
    return { operations: [], unsupported: "UNIQUE INDEX has an unsupported identity" };
  }

  const indexIdentity =
    typeof statement.idxname === "string"
      ? relationMember(relation, statement.idxname)
      : `${relation}:unnamed`;

  return {
    operations: [
      operation(
        `add-unique-index:${indexIdentity}:ast-${canonicalAstDigest(statement)}`,
        `add UNIQUE index ${indexIdentity}`,
      ),
    ],
  };
}

function classifySelect(statement: AstRecord): StatementAnalysis {
  return containsNodeVariant(statement, "FuncCall")
    ? {
        operations: [],
        unsupported:
          "SELECT with an opaque function invocation is outside the supported migration subset",
      }
    : { operations: [] };
}

function classifyFunction(
  statement: AstRecord,
  context: MigrationAnalysisContext,
): StatementAnalysis {
  const identity = canonicalFunctionIdentity(statement);
  if (!identity) {
    return {
      operations: [],
      unsupported: "function or procedure has an unsupported identity",
    };
  }

  const securityMode = functionSecurityMode(statement);
  const label = statement.is_procedure ? "procedure" : "function";
  const contextIdentity = `${label}:${identity}`;
  const priorMode = context.createdFunctionSecurityModes.get(contextIdentity);
  context.createdFunctionSecurityModes.set(contextIdentity, securityMode);

  if (!statement.replace || priorMode === securityMode) return { operations: [] };

  return {
    operations: [
      operation(
        `replace-${label}-${securityMode}:${identity}`,
        `replace ${label} ${identity} as ${securityMode.replace("-", " ").toUpperCase()}`,
      ),
    ],
  };
}

function classifyStatement(
  rawStatement: RawStmt,
  context: MigrationAnalysisContext,
): StatementAnalysis {
  const variant = nodeVariant(rawStatement.stmt);
  if (!variant) return { operations: [], unsupported: "statement has no recognized AST root" };

  const [kind, statement] = variant;

  if (SAFE_STATEMENTS.has(kind)) return { operations: [] };
  if (kind === "DropStmt") return classifyDrop(statement);
  if (kind === "RenameStmt") return classifyRename(statement);
  if (kind === "AlterTableStmt") return classifyAlterTable(statement);
  if (kind === "TruncateStmt") return classifyTruncate(statement);
  if (kind === "DeleteStmt") return classifyDelete(statement);
  if (kind === "UpdateStmt") return classifyUpdate(statement);
  if (kind === "IndexStmt") return classifyIndex(statement);
  if (kind === "SelectStmt") return classifySelect(statement);
  if (kind === "CreateFunctionStmt") return classifyFunction(statement, context);

  if (kind === "ViewStmt") {
    if (!statement.replace) return { operations: [] };
    const view = canonicalRangeVar(statement.view);
    return view
      ? {
          operations: [operation(`replace-view:${view}`, `CREATE OR REPLACE VIEW ${view}`)],
        }
      : { operations: [], unsupported: "VIEW has an unsupported identity" };
  }

  if (kind === "CreateTrigStmt") {
    if (!statement.replace) return { operations: [] };
    const relation = canonicalRangeVar(statement.relation);
    return relation && typeof statement.trigname === "string"
      ? {
          operations: [
            operation(
              `replace-trigger:${relation}.${quotedIdentifier(statement.trigname)}`,
              `CREATE OR REPLACE TRIGGER on ${relation}`,
            ),
          ],
        }
      : { operations: [], unsupported: "TRIGGER has an unsupported identity" };
  }

  if (kind === "AlterPolicyStmt") {
    const relation = canonicalRangeVar(statement.table);
    if (!relation || typeof statement.policy_name !== "string") {
      return { operations: [], unsupported: "ALTER POLICY has an unsupported identity" };
    }

    const policy = `${relation}.${quotedIdentifier(statement.policy_name)}`;
    const operations: Operation[] = [];
    const replacements = [
      ["roles", statement.roles],
      ["using", statement.qual],
      ["with-check", statement.with_check],
    ] as const;

    for (const [component, value] of replacements) {
      if (value !== undefined) {
        operations.push(
          operation(
            `replace-policy-${component}:${policy}:ast-${canonicalAstDigest(value)}`,
            `replace policy ${component} on ${policy}`,
          ),
        );
      }
    }

    return operations.length > 0
      ? { operations }
      : { operations: [], unsupported: "ALTER POLICY contains no supported replacement" };
  }

  if (kind === "CreatePolicyStmt") {
    const relation = canonicalRangeVar(statement.table);
    const policyMode = statement.permissive === true ? "permissive" : "restrictive";
    return relation && typeof statement.policy_name === "string"
      ? {
          operations: [
            operation(
              `add-${policyMode}-policy:${relation}.${quotedIdentifier(
                statement.policy_name,
              )}:ast-${canonicalAstDigest({
                cmd_name: statement.cmd_name,
                qual: statement.qual,
                roles: statement.roles,
                with_check: statement.with_check,
              })}`,
              `add ${policyMode} policy on ${relation}`,
            ),
          ],
        }
      : { operations: [], unsupported: "CREATE POLICY has an unsupported identity" };
  }

  if (kind === "AlterEnumStmt") {
    if (typeof statement.oldVal !== "string") return { operations: [] };
    const type = canonicalName(statement.typeName);
    return type && typeof statement.newVal === "string"
      ? {
          operations: [
            operation(
              `rename-enum-value:${type}:${JSON.stringify(statement.oldVal)}->${JSON.stringify(
                statement.newVal,
              )}`,
              `rename enum value on ${type}`,
            ),
          ],
        }
      : { operations: [], unsupported: "ALTER TYPE RENAME VALUE has an unsupported identity" };
  }

  if (kind === "AlterObjectSchemaStmt") {
    const label = objectLabel(statement.objectType);
    const identity = canonicalRangeVar(statement.relation) ?? canonicalObject(statement.object);
    return label && identity && typeof statement.newschema === "string"
      ? {
          operations: [
            operation(
              `set-schema-${label}:${identity}->${quotedIdentifier(statement.newschema)}`,
              `move ${label} ${identity} to another schema`,
            ),
          ],
        }
      : { operations: [], unsupported: "ALTER ... SET SCHEMA has an unsupported identity" };
  }

  if (kind === "GrantStmt") {
    return statement.is_grant === false
      ? { operations: [], unsupported: "REVOKE is outside the supported migration subset" }
      : { operations: [] };
  }

  if (kind === "GrantRoleStmt") {
    return statement.is_grant === false
      ? { operations: [], unsupported: "REVOKE ROLE is outside the supported migration subset" }
      : { operations: [] };
  }

  if (kind === "RuleStmt" || kind === "CreatePLangStmt") {
    if (!statement.replace) return { operations: [] };
    return {
      operations: [],
      unsupported: `${kind} with OR REPLACE is outside the supported migration subset`,
    };
  }

  return {
    operations: [],
    unsupported: `${kind} is outside the supported migration subset`,
  };
}

function lineAtByteOffset(buffer: Buffer, byteOffset: number): number {
  let line = 1;
  for (let index = 0; index < Math.min(byteOffset, buffer.length); index += 1) {
    if (buffer[index] === 0x0a) line += 1;
  }
  return line;
}

function statementSegment(buffer: Buffer, rawStatement: RawStmt): { start: number; text: string } {
  const start = rawStatement.stmt_location ?? 0;
  const end = rawStatement.stmt_len === undefined ? buffer.length : start + rawStatement.stmt_len;
  return { start, text: buffer.subarray(start, end).toString("utf8") };
}

function parseLeadingWaivers(
  file: string,
  text: string,
  firstLine: number,
  waiverOwners: ReadonlySet<string>,
  issues: MigrationSafetyIssue[],
): ParsedWaiver[] {
  const waivers: ParsedWaiver[] = [];
  let line = firstLine;

  for (const sourceLine of text.split(/\r?\n/)) {
    const trimmed = sourceLine.trim();

    if (trimmed === "") {
      line += 1;
      continue;
    }

    if (!trimmed.startsWith("--")) break;

    if (trimmed.startsWith(WAIVER_PREFIX)) {
      const match = trimmed.match(WAIVER_PATTERN);
      if (!match) {
        issues.push({
          code: "invalid-waiver",
          file,
          line,
          message:
            "waiver must be `-- wallie-migration-safety: allow <canonical-key> owner=@owner issue=TEAM-123`",
        });
      } else if (!waiverOwners.has(match[2])) {
        issues.push({
          code: "unauthorized-waiver-owner",
          file,
          line,
          message: `waiver owner ${match[2]} is not in the approved owner list`,
        });
      } else {
        waivers.push({
          key: match[1],
          owner: match[2],
          issue: match[3],
          line,
          consumed: false,
        });
      }
    }

    line += 1;
  }

  return waivers;
}

function leadingWaivers(
  file: string,
  sqlBuffer: Buffer,
  rawStatement: RawStmt,
  waiverOwners: ReadonlySet<string>,
  issues: MigrationSafetyIssue[],
): ParsedWaiver[] {
  const segment = statementSegment(sqlBuffer, rawStatement);
  return parseLeadingWaivers(
    file,
    segment.text,
    lineAtByteOffset(sqlBuffer, segment.start),
    waiverOwners,
    issues,
  );
}

function reportUnusedWaivers(
  file: string,
  waivers: readonly ParsedWaiver[],
  issues: MigrationSafetyIssue[],
): void {
  for (const waiver of waivers.filter((candidate) => !candidate.consumed)) {
    issues.push({
      code: "unused-waiver",
      file,
      line: waiver.line,
      message: `waiver ${waiver.key} owned by ${waiver.owner} for ${waiver.issue} matched no operation in its statement`,
    });
  }
}

function reportTrailingWaivers(
  file: string,
  sqlBuffer: Buffer,
  statements: readonly RawStmt[],
  waiverOwners: ReadonlySet<string>,
  issues: MigrationSafetyIssue[],
): void {
  const lastStatement = statements.at(-1);
  let start = 0;

  if (lastStatement) {
    if (lastStatement.stmt_len === undefined) return;
    start = (lastStatement.stmt_location ?? 0) + lastStatement.stmt_len;
    if (sqlBuffer[start] === 0x3b) start += 1;
  }

  const waivers = parseLeadingWaivers(
    file,
    sqlBuffer.subarray(start).toString("utf8"),
    lineAtByteOffset(sqlBuffer, start),
    waiverOwners,
    issues,
  );
  reportUnusedWaivers(file, waivers, issues);
}

async function inspectNewMigration(
  file: string,
  sql: string,
  waiverOwners: ReadonlySet<string>,
): Promise<MigrationSafetyIssue[]> {
  const issues: MigrationSafetyIssue[] = [];
  let parsed: ParseResult;

  try {
    parsed = await postgresParser.parse(sql);
  } catch (error) {
    issues.push({
      code: "sql-parse-error",
      file,
      message: `PostgreSQL 17 parser rejected this migration: ${
        error instanceof Error ? error.message : String(error)
      }`,
    });
    return issues;
  }

  const sqlBuffer = Buffer.from(sql, "utf8");
  const analysisContext: MigrationAnalysisContext = {
    createdFunctionSecurityModes: new Map(),
  };

  for (const rawStatement of parsed.stmts ?? []) {
    const statementLine = lineAtByteOffset(sqlBuffer, rawStatement.stmt_location ?? 0);
    const waivers = leadingWaivers(file, sqlBuffer, rawStatement, waiverOwners, issues);
    const analysis = classifyStatement(rawStatement, analysisContext);

    if (analysis.unsupported) {
      issues.push({
        code: "unsupported-ddl",
        file,
        line: statementLine,
        message: `${analysis.unsupported}; fail-closed migration review is required`,
      });
    }

    for (const unsafeOperation of analysis.operations) {
      const waiver = waivers.find(
        (candidate) => !candidate.consumed && candidate.key === unsafeOperation.key,
      );

      if (waiver) {
        waiver.consumed = true;
      } else {
        issues.push({
          code: "unwaived-operation",
          file,
          line: statementLine,
          message: `${unsafeOperation.description} requires an exact waiver with key ${unsafeOperation.key}`,
        });
      }
    }

    reportUnusedWaivers(file, waivers, issues);
  }

  reportTrailingWaivers(file, sqlBuffer, parsed.stmts ?? [], waiverOwners, issues);
  return issues;
}

function historicalIssues(
  baseMigrations: MigrationFiles,
  currentMigrations: MigrationFiles,
): MigrationSafetyIssue[] {
  const issues: MigrationSafetyIssue[] = [];
  const addedFiles = Object.keys(currentMigrations).filter(
    (file) => baseMigrations[file] === undefined,
  );

  for (const file of Object.keys(baseMigrations).sort()) {
    const baseContents = baseMigrations[file];
    const currentContents = currentMigrations[file];

    if (currentContents === undefined) {
      const renamedTo = addedFiles.find(
        (candidate) => currentMigrations[candidate] === baseContents,
      );
      issues.push({
        code: renamedTo ? "historical-migration-renamed" : "historical-migration-deleted",
        file,
        message: renamedTo
          ? `historical migration was renamed to ${renamedTo}`
          : "historical migration was deleted",
      });
      continue;
    }

    if (currentContents !== baseContents) {
      issues.push({
        code: "historical-migration-edited",
        file,
        message: "historical migration differs byte-for-byte from the comparison base",
      });
    }
  }

  return issues;
}

function migrationVersion(file: string): string | undefined {
  return file.match(/^(\d{14})_/)?.[1];
}

function backdatedMigrationIssues(
  baseMigrations: MigrationFiles,
  currentMigrations: MigrationFiles,
): MigrationSafetyIssue[] {
  const newestBaseVersion = Object.keys(baseMigrations)
    .map(migrationVersion)
    .filter((version): version is string => version !== undefined)
    .sort()
    .at(-1);

  if (!newestBaseVersion) return [];

  return Object.keys(currentMigrations)
    .filter((file) => baseMigrations[file] === undefined)
    .sort()
    .flatMap((file) => {
      const version = migrationVersion(file);
      return version !== undefined && version <= newestBaseVersion
        ? [
            {
              code: "backdated-migration" as const,
              file,
              message: `new migration version ${version} must be later than comparison-base version ${newestBaseVersion}`,
            },
          ]
        : [];
    });
}

export async function verifyMigrationSafety({
  baseMigrations,
  currentMigrations,
  waiverOwners,
}: VerifyMigrationSafetyOptions): Promise<MigrationSafetyIssue[]> {
  const issues = [
    ...historicalIssues(baseMigrations, currentMigrations),
    ...backdatedMigrationIssues(baseMigrations, currentMigrations),
  ];
  const approvedOwners = new Set(waiverOwners);
  const newFiles = Object.keys(currentMigrations)
    .filter((file) => baseMigrations[file] === undefined)
    .sort();

  for (const file of newFiles) {
    issues.push(...(await inspectNewMigration(file, currentMigrations[file], approvedOwners)));
  }

  return issues;
}
