export type MigrationFiles = Readonly<Record<string, string>>;

export type MigrationSafetyIssueCode =
  | "historical-migration-changed"
  | "historical-migration-missing"
  | "invalid-sql"
  | "invalid-waiver"
  | "unsafe-operation"
  | "unused-waiver";

export type MigrationSafetyIssue = {
  code: MigrationSafetyIssueCode;
  file: string;
  line?: number;
  message: string;
  operationKey?: string;
};

type TokenKind = "comment" | "identifier" | "quoted-identifier" | "string" | "symbol";

type Token = {
  kind: TokenKind;
  line: number;
  value: string;
};

type UnsafeOperation = {
  key: string;
  line: number;
};

type FunctionContract = {
  identity: string;
  kind: "function" | "procedure";
  result: string;
};

type Waiver = {
  issue: string;
  key: string;
  line: number;
  owner: string;
  used: boolean;
};

type VerifyMigrationSafetyInput = {
  baseMigrations: MigrationFiles;
  currentMigrations: MigrationFiles;
  waiverOwners: readonly string[];
};

const WAIVER_MARKER = "wallie-migration-safety:";
const WAIVER_PATTERN =
  /wallie-migration-safety:\s*allow\s+(\S+)\s+owner=(@[A-Za-z0-9-]+)\s+issue=([A-Z][A-Z0-9]+-\d+)\b/gu;

const MULTIWORD_TYPES = new Set([
  "bit varying",
  "character varying",
  "double precision",
  "time with time zone",
  "time without time zone",
  "timestamp with time zone",
  "timestamp without time zone",
]);

const FUNCTION_OPTION_KEYWORDS = new Set([
  "as",
  "begin",
  "called",
  "cost",
  "immutable",
  "language",
  "leakproof",
  "not",
  "parallel",
  "return",
  "rows",
  "security",
  "set",
  "stable",
  "strict",
  "support",
  "transform",
  "volatile",
  "window",
]);

function isIdentifierStart(character: string): boolean {
  return /[A-Za-z_]/u.test(character);
}

function isIdentifierPart(character: string): boolean {
  return /[A-Za-z0-9_$]/u.test(character);
}

function advanceLine(line: number, value: string): number {
  return line + (value.match(/\n/gu)?.length ?? 0);
}

function tokenizeSql(sql: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;

  while (index < sql.length) {
    const character = sql[index]!;

    if (/\s/u.test(character)) {
      if (character === "\n") line += 1;
      index += 1;
      continue;
    }

    if (character === "-" && sql[index + 1] === "-") {
      const start = index;
      const startLine = line;
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      const value = sql.slice(start, index);
      tokens.push({ kind: "comment", line: startLine, value });
      continue;
    }

    if (character === "/" && sql[index + 1] === "*") {
      const start = index;
      const startLine = line;
      let depth = 1;
      index += 2;

      while (index < sql.length && depth > 0) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          if (sql[index] === "\n") line += 1;
          index += 1;
        }
      }

      if (depth !== 0) throw new Error(`unterminated block comment at line ${startLine}`);
      tokens.push({ kind: "comment", line: startLine, value: sql.slice(start, index) });
      continue;
    }

    if (character === "'") {
      const start = index;
      const startLine = line;
      const escapeString =
        /[eE]/u.test(sql[start - 1] ?? "") && !isIdentifierPart(sql[start - 2] ?? "");
      index += 1;
      let terminated = false;

      while (index < sql.length) {
        if (escapeString && sql[index] === "\\") {
          if (sql[index + 1] === "\n") line += 1;
          index += 2;
        } else if (sql[index] === "'" && sql[index + 1] === "'") {
          index += 2;
        } else if (sql[index] === "'") {
          index += 1;
          terminated = true;
          break;
        } else {
          if (sql[index] === "\n") line += 1;
          index += 1;
        }
      }

      if (!terminated) throw new Error(`unterminated string at line ${startLine}`);
      tokens.push({ kind: "string", line: startLine, value: sql.slice(start, index) });
      continue;
    }

    if (character === '"') {
      const startLine = line;
      index += 1;
      let value = "";
      let terminated = false;

      while (index < sql.length) {
        if (sql[index] === '"' && sql[index + 1] === '"') {
          value += '"';
          index += 2;
        } else if (sql[index] === '"') {
          index += 1;
          terminated = true;
          break;
        } else {
          if (sql[index] === "\n") line += 1;
          value += sql[index];
          index += 1;
        }
      }

      if (!terminated) throw new Error(`unterminated quoted identifier at line ${startLine}`);
      tokens.push({ kind: "quoted-identifier", line: startLine, value });
      continue;
    }

    if (character === "$") {
      const tagMatch = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u);
      if (tagMatch) {
        const tag = tagMatch[0];
        const start = index;
        const startLine = line;
        const end = sql.indexOf(tag, index + tag.length);
        if (end === -1) throw new Error(`unterminated dollar-quoted string at line ${startLine}`);
        index = end + tag.length;
        const value = sql.slice(start, index);
        line = advanceLine(line, value);
        tokens.push({ kind: "string", line: startLine, value });
        continue;
      }
    }

    if (isIdentifierStart(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && isIdentifierPart(sql[index]!)) index += 1;
      tokens.push({ kind: "identifier", line, value: sql.slice(start, index) });
      continue;
    }

    if (/[0-9]/u.test(character)) {
      const start = index;
      index += 1;
      while (index < sql.length && /[0-9.]/u.test(sql[index]!)) index += 1;
      tokens.push({ kind: "identifier", line, value: sql.slice(start, index) });
      continue;
    }

    const twoCharacterSymbol = sql.slice(index, index + 2);
    if (["::", "=>", ">=", "<=", "<>", "!="].includes(twoCharacterSymbol)) {
      tokens.push({ kind: "symbol", line, value: twoCharacterSymbol });
      index += 2;
    } else {
      tokens.push({ kind: "symbol", line, value: character });
      index += 1;
    }
  }

  return tokens;
}

function isKeyword(token: Token | undefined, keyword: string): boolean {
  return token?.kind === "identifier" && token.value.toLowerCase() === keyword;
}

function isNameToken(
  token: Token | undefined,
): token is Token & { kind: "identifier" | "quoted-identifier" } {
  return token?.kind === "identifier" || token?.kind === "quoted-identifier";
}

function canonicalNameToken(token: Token): string {
  return token.kind === "quoted-identifier"
    ? encodeURIComponent(token.value)
    : token.value.toLowerCase();
}

function readQualifiedName(tokens: readonly Token[], start: number) {
  const parts: string[] = [];
  let index = start;

  if (!isNameToken(tokens[index])) return { name: "unknown", next: index };

  parts.push(canonicalNameToken(tokens[index]!));
  index += 1;

  while (tokens[index]?.value === "." && isNameToken(tokens[index + 1])) {
    parts.push(canonicalNameToken(tokens[index + 1]!));
    index += 2;
  }

  return { name: parts.join("."), next: index };
}

function splitTopLevel(tokens: readonly Token[], separator: string): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;

  for (const token of tokens) {
    if (token.value === "(" || token.value === "[") depth += 1;
    if (token.value === ")" || token.value === "]") depth -= 1;

    if (token.value === separator && depth === 0) {
      parts.push(current);
      current = [];
    } else {
      current.push(token);
    }
  }

  parts.push(current);
  return parts;
}

function matchingParenthesis(tokens: readonly Token[], openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function normalizedTokens(tokens: readonly Token[]): string {
  let result = "";
  let previousWasName = false;

  for (const token of tokens) {
    const isName = isNameToken(token);
    if (isName && previousWasName) result += "_";
    result += isName ? canonicalNameToken(token) : token.value.toLowerCase();
    previousWasName = isName;
  }

  return result;
}

function functionArgumentType(tokens: readonly Token[], declaration: boolean): string | undefined {
  let argument = [...tokens];
  const defaultIndex = argument.findIndex(
    (token) => isKeyword(token, "default") || token.value === "=",
  );
  if (defaultIndex !== -1) argument = argument.slice(0, defaultIndex);

  const mode = argument[0]?.kind === "identifier" ? argument[0].value.toLowerCase() : undefined;
  if (mode && ["in", "inout", "out", "variadic"].includes(mode)) {
    argument = argument.slice(1);
    if (mode === "out") return undefined;
  }

  if (declaration && argument.length > 1 && isNameToken(argument[0])) {
    const words = argument
      .filter((token) => isNameToken(token))
      .map((token) => token.value.toLowerCase())
      .join(" ");
    const startsWithKnownType = [...MULTIWORD_TYPES].some(
      (type) => words === type || words.startsWith(`${type} `),
    );
    const schemaQualifiedType = argument[1]?.value === ".";
    const decoratedType =
      ["[", "(", "%"].includes(argument[1]?.value ?? "") || isKeyword(argument[1], "array");
    if (!startsWithKnownType && !schemaQualifiedType && !decoratedType) {
      argument = argument.slice(1);
    }
  }

  return normalizedTokens(argument);
}

function readFunctionIdentity(
  tokens: readonly Token[],
  nameStart: number,
  declaration: boolean,
): { identity?: string; next: number } {
  const { name, next } = readQualifiedName(tokens, nameStart);
  if (tokens[next]?.value !== "(") return { next };

  const closeIndex = matchingParenthesis(tokens, next);
  if (closeIndex === -1) return { next };

  const argumentTypes = splitTopLevel(tokens.slice(next + 1, closeIndex), ",")
    .map((argument) => functionArgumentType(argument, declaration))
    .filter((argument): argument is string => Boolean(argument));

  return {
    identity: `${name}(${argumentTypes.join(",")})`,
    next: closeIndex + 1,
  };
}

function readCreatedFunction(tokens: readonly Token[]): FunctionContract | undefined {
  if (!isKeyword(tokens[0], "create")) return undefined;

  const kindIndex = isKeyword(tokens[1], "or") && isKeyword(tokens[2], "replace") ? 3 : 1;
  const kind = isKeyword(tokens[kindIndex], "function")
    ? "function"
    : isKeyword(tokens[kindIndex], "procedure")
      ? "procedure"
      : undefined;
  if (!kind) return undefined;

  const parsed = readFunctionIdentity(tokens, kindIndex + 1, true);
  if (!parsed.identity) return undefined;
  if (kind === "procedure") {
    return { identity: parsed.identity, kind, result: "procedure" };
  }

  const returnsIndex = tokens.findIndex(
    (token, index) => index >= parsed.next && isKeyword(token, "returns"),
  );
  if (returnsIndex === -1) return undefined;

  let depth = 0;
  let resultEnd = returnsIndex + 1;
  for (; resultEnd < tokens.length; resultEnd += 1) {
    const token = tokens[resultEnd]!;
    if (token.value === "(" || token.value === "[") depth += 1;
    if (token.value === ")" || token.value === "]") depth -= 1;
    if (
      resultEnd > returnsIndex + 1 &&
      depth === 0 &&
      token.kind === "identifier" &&
      FUNCTION_OPTION_KEYWORDS.has(token.value.toLowerCase())
    ) {
      break;
    }
  }

  const result = normalizedTokens(tokens.slice(returnsIndex + 1, resultEnd));
  return result ? { identity: parsed.identity, kind, result } : undefined;
}

function splitStatements(tokens: readonly Token[]): Token[][] {
  return splitTopLevel(tokens, ";").filter((statement) =>
    statement.some((token) => token.kind !== "comment"),
  );
}

function extractWaivers(tokens: readonly Token[], file: string, owners: readonly string[]) {
  const waivers: Waiver[] = [];
  const issues: MigrationSafetyIssue[] = [];

  for (const token of tokens.filter((candidate) => candidate.kind === "comment")) {
    if (!token.value.includes(WAIVER_MARKER)) continue;

    WAIVER_PATTERN.lastIndex = 0;
    const matches = [...token.value.matchAll(WAIVER_PATTERN)];
    const markerCount = token.value.split(WAIVER_MARKER).length - 1;
    if (matches.length !== 1 || markerCount !== 1) {
      issues.push({
        code: "invalid-waiver",
        file,
        line: token.line,
        message:
          "migration safety annotation must be `wallie-migration-safety: allow <operation-key> owner=@owner issue=TEAM-123`",
      });
      continue;
    }

    const [, key, owner, issue] = matches[0]!;
    if (!owners.includes(owner!)) {
      issues.push({
        code: "invalid-waiver",
        file,
        line: token.line,
        message: `migration safety waiver owner ${owner} is not one of: ${owners.join(", ")}`,
      });
      continue;
    }

    waivers.push({ issue: issue!, key: key!, line: token.line, owner: owner!, used: false });
  }

  return { issues, waivers };
}

function dropKind(tokens: readonly Token[], start: number) {
  const twoWordKinds = [
    ["materialized", "view"],
    ["foreign", "table"],
    ["event", "trigger"],
  ];

  for (const [first, second] of twoWordKinds) {
    if (isKeyword(tokens[start], first!) && isKeyword(tokens[start + 1], second!)) {
      return { kind: `${first}-${second}`, next: start + 2 };
    }
  }

  return {
    kind: isNameToken(tokens[start]) ? canonicalNameToken(tokens[start]!) : "object",
    next: start + 1,
  };
}

function skipIfExists(tokens: readonly Token[], start: number): number {
  return isKeyword(tokens[start], "if") && isKeyword(tokens[start + 1], "exists")
    ? start + 2
    : start;
}

function parseDropStatement(tokens: readonly Token[]): UnsafeOperation[] {
  const { kind, next: afterKind } = dropKind(tokens, 1);
  let index = afterKind;
  if (kind === "index" && isKeyword(tokens[index], "concurrently")) index += 1;
  index = skipIfExists(tokens, index);
  const operations: UnsafeOperation[] = [];

  for (const item of splitTopLevel(tokens.slice(index), ",")) {
    if (kind === "function" || kind === "procedure") {
      const parsed = readFunctionIdentity(item, 0, true);
      const identity = parsed.identity ?? readQualifiedName(item, 0).name;
      operations.push({
        key: `drop-${kind}:${identity}`,
        line: tokens[0]!.line,
      });
    } else if (kind === "policy") {
      const policy = readQualifiedName(item, 0);
      const relation = isKeyword(item[policy.next], "on")
        ? readQualifiedName(item, policy.next + 1).name
        : "unknown";
      operations.push({
        key: `drop-policy:${relation}.${policy.name}`,
        line: tokens[0]!.line,
      });
    } else {
      const name = readQualifiedName(item, 0).name;
      operations.push({ key: `drop-${kind}:${name}`, line: tokens[0]!.line });
    }
  }

  return operations;
}

function alterObject(tokens: readonly Token[]) {
  const { kind, next: afterKind } = dropKind(tokens, 1);
  let index = skipIfExists(tokens, afterKind);
  if (isKeyword(tokens[index], "only")) index += 1;

  if (kind === "function" || kind === "procedure") {
    const parsed = readFunctionIdentity(tokens, index, true);
    return {
      kind,
      name: parsed.identity ?? readQualifiedName(tokens, index).name,
      next: parsed.next,
    };
  }

  if (kind === "policy") {
    const policy = readQualifiedName(tokens, index);
    const relation = isKeyword(tokens[policy.next], "on")
      ? readQualifiedName(tokens, policy.next + 1)
      : { name: "unknown", next: policy.next };
    return {
      kind,
      name: `${relation.name}.${policy.name}`,
      next: relation.next,
    };
  }

  const name = readQualifiedName(tokens, index);
  return {
    kind,
    name: name.name,
    next: tokens[name.next]?.value === "*" ? name.next + 1 : name.next,
  };
}

function actionName(tokens: readonly Token[], start: number): string {
  return readQualifiedName(tokens, start).name;
}

function parseAlterAction(
  objectKind: string,
  objectName: string,
  action: readonly Token[],
): UnsafeOperation[] {
  if (action.length === 0) return [];
  const line = action[0]!.line;

  if (isKeyword(action[0], "drop")) {
    let index = 1;
    let targetKind = "object";
    if (isNameToken(action[index]) && !isKeyword(action[index], "if")) {
      targetKind = canonicalNameToken(action[index]!);
      index += 1;
    }
    index = skipIfExists(action, index);
    const target = actionName(action, index);
    return [{ key: `drop-${targetKind}:${objectName}.${target}`, line }];
  }

  if (isKeyword(action[0], "rename")) {
    let index = 1;
    let targetKind = objectKind;
    if (isKeyword(action[index], "column") || isKeyword(action[index], "constraint")) {
      targetKind = action[index]!.value.toLowerCase();
      index += 1;
    } else if (isKeyword(action[index], "value")) {
      targetKind = "value";
      index += 1;
    } else if (isKeyword(action[index], "to")) {
      return [{ key: `rename-${objectKind}:${objectName}`, line }];
    } else if (objectKind === "table" || objectKind.endsWith("-view")) {
      targetKind = "column";
    }
    const target = actionName(action, index);
    return [{ key: `rename-${targetKind}:${objectName}.${target}`, line }];
  }

  if (isKeyword(action[0], "alter")) {
    const targetKind =
      objectKind === "type" && isKeyword(action[1], "attribute") ? "attribute" : "column";
    const targetIndex = isKeyword(action[1], "column") || isKeyword(action[1], "attribute") ? 2 : 1;
    const target = actionName(action, targetIndex);
    const operationIndex = targetIndex + 1;

    if (isKeyword(action[operationIndex], "type")) {
      return [{ key: `replace-${targetKind}-type:${objectName}.${target}`, line }];
    }
    if (
      isKeyword(action[operationIndex], "set") &&
      isKeyword(action[operationIndex + 1], "data") &&
      isKeyword(action[operationIndex + 2], "type")
    ) {
      return [{ key: `replace-${targetKind}-type:${objectName}.${target}`, line }];
    }
    if (isKeyword(action[operationIndex], "drop")) {
      const property = normalizedTokens(action.slice(operationIndex + 1)) || "property";
      return [{ key: `drop-${targetKind}-${property}:${objectName}.${target}`, line }];
    }
  }

  if (isKeyword(action[0], "set") && isKeyword(action[1], "schema")) {
    return [{ key: `rename-${objectKind}-schema:${objectName}`, line }];
  }

  return [];
}

function parseAlterStatement(tokens: readonly Token[]): UnsafeOperation[] {
  const object = alterObject(tokens);
  let actionStart = object.next;
  let depth = 0;

  for (let index = object.next; index < tokens.length; index += 1) {
    if (tokens[index]?.value === "(") depth += 1;
    if (tokens[index]?.value === ")") depth -= 1;
    if (
      depth === 0 &&
      ["alter", "drop", "rename", "set"].some((keyword) => isKeyword(tokens[index], keyword))
    ) {
      actionStart = index;
      break;
    }
  }

  return splitTopLevel(tokens.slice(actionStart), ",").flatMap((action) =>
    parseAlterAction(object.kind, object.name, action),
  );
}

function parseReplacement(tokens: readonly Token[]): UnsafeOperation[] {
  if (
    !isKeyword(tokens[0], "create") ||
    !isKeyword(tokens[1], "or") ||
    !isKeyword(tokens[2], "replace")
  ) {
    return [];
  }

  if (isKeyword(tokens[3], "function") || isKeyword(tokens[3], "procedure")) return [];

  const { kind, next } = dropKind(tokens, 3);
  const name = readQualifiedName(tokens, next).name;
  return [{ key: `replace-${kind}:${name}`, line: tokens[0]!.line }];
}

function parseStatementOperations(tokens: readonly Token[]): UnsafeOperation[] {
  if (isKeyword(tokens[0], "drop")) return parseDropStatement(tokens);
  if (isKeyword(tokens[0], "alter")) return parseAlterStatement(tokens);
  return parseReplacement(tokens);
}

function stringContents(token: Token): string | undefined {
  if (token.kind !== "string") return undefined;

  if (token.value.startsWith("$")) {
    const tag = token.value.match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u)?.[0];
    if (!tag || !token.value.endsWith(tag)) return undefined;
    return token.value.slice(tag.length, -tag.length);
  }

  if (token.value.startsWith("'") && token.value.endsWith("'")) {
    return token.value
      .slice(1, -1)
      .replaceAll("''", "'")
      .replace(/\\([\s\S])/gu, "$1");
  }

  return undefined;
}

function operationLine(operation: UnsafeOperation, baseLine: number): UnsafeOperation {
  return { ...operation, line: baseLine + operation.line - 1 };
}

function parseDoStatement(
  tokens: readonly Token[],
  knownFunctionContracts: ReadonlyMap<string, string>,
): UnsafeOperation[] {
  if (!isKeyword(tokens[0], "do")) return [];

  const bodyToken = tokens.find((token) => token.kind === "string");
  const body = bodyToken ? stringContents(bodyToken) : undefined;
  if (!bodyToken || body === undefined) return [];

  const bodyTokens = tokenizeSql(body);
  const operations: UnsafeOperation[] = [];

  for (const statementWithComments of splitStatements(bodyTokens)) {
    const statement = statementWithComments.filter((token) => token.kind !== "comment");

    for (let index = 0; index < statement.length; index += 1) {
      if (isKeyword(statement[index], "execute")) {
        let sqlIndex = index + 1;
        if (isKeyword(statement[sqlIndex], "e")) sqlIndex += 1;
        const sqlToken = statement[sqlIndex];
        const dynamicSql = sqlToken ? stringContents(sqlToken) : undefined;
        const isConstant =
          dynamicSql !== undefined &&
          statement[sqlIndex + 1]?.value !== "||" &&
          !isKeyword(statement[sqlIndex + 1], "format");
        if (isConstant) {
          operations.push(
            ...parseOperations(tokenizeSql(dynamicSql), knownFunctionContracts).map(
              (operation) => ({
                ...operation,
                line: bodyToken.line + statement[index]!.line - 1,
              }),
            ),
          );
        }
        continue;
      }

      if (
        isKeyword(statement[index], "drop") ||
        isKeyword(statement[index], "alter") ||
        isKeyword(statement[index], "create")
      ) {
        const embedded = parseStatementOperations(statement.slice(index));
        if (embedded.length > 0) {
          operations.push(...embedded.map((operation) => operationLine(operation, bodyToken.line)));
          break;
        }
      }
    }
  }

  return operations;
}

function functionContractKey(contract: Pick<FunctionContract, "identity" | "kind">): string {
  return `${contract.kind}:${contract.identity}`;
}

function droppedFunction(operation: UnsafeOperation):
  | {
      identity: string;
      kind: "function" | "procedure";
    }
  | undefined {
  const match = operation.key.match(/^drop-(function|procedure):(.+)$/u);
  return match ? { identity: match[2]!, kind: match[1] as "function" | "procedure" } : undefined;
}

function parseOperations(
  tokens: readonly Token[],
  knownFunctionContracts: ReadonlyMap<string, string>,
): UnsafeOperation[] {
  const parsedStatements = splitStatements(tokens).map((statementWithComments) => {
    const statement = statementWithComments.filter((token) => token.kind !== "comment");
    return {
      createdFunction: readCreatedFunction(statement),
      operations: [
        ...parseStatementOperations(statement),
        ...parseDoStatement(statement, knownFunctionContracts),
      ],
    };
  });
  const laterCompatibleFunctions = new Map<string, number>();
  const unsafeOperations: UnsafeOperation[] = [];

  for (const statement of parsedStatements.toReversed()) {
    if (statement.createdFunction) {
      const contract = statement.createdFunction;
      const key = `${functionContractKey(contract)}->${contract.result}`;
      laterCompatibleFunctions.set(key, (laterCompatibleFunctions.get(key) ?? 0) + 1);
    }

    for (const operation of statement.operations.toReversed()) {
      const dropped = droppedFunction(operation);
      const deployedResult = dropped
        ? knownFunctionContracts.get(functionContractKey(dropped))
        : undefined;
      const replacementKey =
        dropped && deployedResult
          ? `${functionContractKey(dropped)}->${deployedResult}`
          : undefined;
      const availableReplacements = replacementKey
        ? (laterCompatibleFunctions.get(replacementKey) ?? 0)
        : 0;

      if (replacementKey && availableReplacements > 0) {
        laterCompatibleFunctions.set(replacementKey, availableReplacements - 1);
      } else {
        unsafeOperations.push(operation);
      }
    }
  }

  return unsafeOperations.reverse();
}

function updateFunctionContracts(contracts: Map<string, string>, sql: string): void {
  let tokens: Token[];
  try {
    tokens = tokenizeSql(sql);
  } catch {
    return;
  }

  for (const statementWithComments of splitStatements(tokens)) {
    const statement = statementWithComments.filter((token) => token.kind !== "comment");
    const created = readCreatedFunction(statement);
    if (created) contracts.set(functionContractKey(created), created.result);

    if (isKeyword(statement[0], "drop")) {
      for (const operation of parseDropStatement(statement)) {
        const dropped = droppedFunction(operation);
        if (dropped) contracts.delete(functionContractKey(dropped));
      }
    }
  }
}

function verifyNewMigration(
  file: string,
  sql: string,
  waiverOwners: readonly string[],
  knownFunctionContracts: ReadonlyMap<string, string>,
): MigrationSafetyIssue[] {
  let tokens: Token[];
  let operations: UnsafeOperation[];
  try {
    tokens = tokenizeSql(sql);
    operations = parseOperations(tokens, knownFunctionContracts);
  } catch (error) {
    return [
      {
        code: "invalid-sql",
        file,
        message: error instanceof Error ? error.message : "could not tokenize SQL",
      },
    ];
  }

  const { issues, waivers } = extractWaivers(tokens, file, waiverOwners);

  for (const operation of operations) {
    const waiver = waivers.find((candidate) => !candidate.used && candidate.key === operation.key);
    if (waiver) {
      waiver.used = true;
      continue;
    }

    issues.push({
      code: "unsafe-operation",
      file,
      line: operation.line,
      message: `unsafe migration operation requires a narrow waiver for ${operation.key}`,
      operationKey: operation.key,
    });
  }

  for (const waiver of waivers.filter((candidate) => !candidate.used)) {
    issues.push({
      code: "unused-waiver",
      file,
      line: waiver.line,
      message: `unused migration safety waiver for ${waiver.key} (${waiver.owner}, ${waiver.issue})`,
      operationKey: waiver.key,
    });
  }

  return issues;
}

export function verifyMigrationSafety(input: VerifyMigrationSafetyInput): MigrationSafetyIssue[] {
  const issues: MigrationSafetyIssue[] = [];
  const functionContracts = new Map<string, string>();

  for (const [file, baseSql] of Object.entries(input.baseMigrations).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    updateFunctionContracts(functionContracts, baseSql);
    const currentSql = input.currentMigrations[file];
    if (currentSql === undefined) {
      issues.push({
        code: "historical-migration-missing",
        file,
        message: "migration exists on the comparison base and cannot be renamed or deleted",
      });
    } else if (currentSql !== baseSql) {
      issues.push({
        code: "historical-migration-changed",
        file,
        message: "migration exists on the comparison base and cannot be edited",
      });
    }
  }

  for (const [file, sql] of Object.entries(input.currentMigrations).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (input.baseMigrations[file] === undefined) {
      issues.push(...verifyNewMigration(file, sql, input.waiverOwners, functionContracts));
      updateFunctionContracts(functionContracts, sql);
    }
  }

  return issues.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      (left.line ?? 0) - (right.line ?? 0) ||
      left.code.localeCompare(right.code),
  );
}
