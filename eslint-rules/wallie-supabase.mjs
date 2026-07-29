const transparentExpressionTypes = new Set([
  "ChainExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

function unwrapExpression(node) {
  let current = node;

  while (current && transparentExpressionTypes.has(current.type) && "expression" in current) {
    current = current.expression;
  }

  return current;
}

function outermostTransparentExpression(node) {
  let current = node;

  while (
    current.parent &&
    transparentExpressionTypes.has(current.parent.type) &&
    current.parent.expression === current
  ) {
    current = current.parent;
  }

  return current;
}

function staticPropertyName(node) {
  const property = node.type === "Property" ? node.key : node.property;

  if (!node.computed && property.type === "Identifier") {
    return property.name;
  }

  if (node.computed && property.type === "Literal") {
    return property.value;
  }

  if (
    node.computed &&
    property.type === "TemplateLiteral" &&
    property.expressions.length === 0 &&
    property.quasis.length === 1
  ) {
    return property.quasis[0].value.cooked ?? property.quasis[0].value.raw;
  }

  return undefined;
}

function objectPatternSource(pattern) {
  const parent = pattern.parent;

  if (parent?.type === "VariableDeclarator" && parent.id === pattern) {
    return parent.init;
  }

  if (parent?.type === "AssignmentExpression" && parent.left === pattern) {
    return parent.right;
  }

  return pattern;
}

function isDeclarationFromSupabaseJs(declaration) {
  const fileName = declaration.getSourceFile().fileName.replaceAll("\\", "/");
  return fileName.includes("/node_modules/@supabase/supabase-js/");
}

function createNoUnboundSupabaseClientMethods(context) {
  const sourceCode = context.sourceCode;
  const services = sourceCode.parserServices;

  if (!services?.program || !services.esTreeNodeToTSNodeMap) {
    throw new Error(
      "wallie-supabase/no-unbound-client-methods requires TypeScript type information.",
    );
  }

  const checker = services.program.getTypeChecker();

  function hasSupabaseRpc(typeNode) {
    let current = typeNode;

    while (current) {
      const tsNode = services.esTreeNodeToTSNodeMap.get(current);
      const type = checker.getTypeAtLocation(tsNode);
      const rpc = checker.getPropertyOfType(type, "rpc");

      if (rpc?.declarations?.some(isDeclarationFromSupabaseJs)) {
        return true;
      }

      if (!transparentExpressionTypes.has(current.type) || !("expression" in current)) {
        return false;
      }

      current = current.expression;
    }

    return false;
  }

  function sameReceiver(left, right) {
    const unwrappedLeft = unwrapExpression(left);
    const unwrappedRight = unwrapExpression(right);

    if (!unwrappedLeft || !unwrappedRight) return false;

    if (unwrappedLeft.type === "ThisExpression" && unwrappedRight.type === "ThisExpression") {
      return true;
    }

    if (unwrappedLeft.type !== "Identifier" || unwrappedRight.type !== "Identifier") {
      return false;
    }

    const leftSymbol = checker.getSymbolAtLocation(
      services.esTreeNodeToTSNodeMap.get(unwrappedLeft),
    );
    const rightSymbol = checker.getSymbolAtLocation(
      services.esTreeNodeToTSNodeMap.get(unwrappedRight),
    );

    return leftSymbol !== undefined && leftSymbol === rightSymbol;
  }

  function isReceiverPreservingUse(node) {
    const expression = outermostTransparentExpression(node);
    const parent = expression.parent;

    if (parent?.type === "CallExpression" && parent.callee === expression) {
      return true;
    }

    if (
      parent?.type !== "MemberExpression" ||
      parent.object !== expression ||
      staticPropertyName(parent) !== "bind"
    ) {
      return false;
    }

    const bindExpression = outermostTransparentExpression(parent);
    const bindCall = bindExpression.parent;

    return (
      bindCall?.type === "CallExpression" &&
      bindCall.callee === bindExpression &&
      sameReceiver(node.object, bindCall.arguments[0])
    );
  }

  function report(node) {
    context.report({
      messageId: "unbound",
      node,
    });
  }

  return {
    MemberExpression(node) {
      if (
        staticPropertyName(node) === "rpc" &&
        hasSupabaseRpc(node.object) &&
        !isReceiverPreservingUse(node)
      ) {
        report(node);
      }
    },
    Property(node) {
      if (
        node.parent.type === "ObjectPattern" &&
        staticPropertyName(node) === "rpc" &&
        hasSupabaseRpc(objectPatternSource(node.parent))
      ) {
        report(node);
      }
    },
  };
}

const wallieSupabasePlugin = {
  rules: {
    "no-unbound-client-methods": {
      create: createNoUnboundSupabaseClientMethods,
      meta: {
        docs: {
          description: "Require Supabase client methods to retain their client receiver.",
        },
        messages: {
          unbound:
            "Supabase client methods depend on their receiver. Call `client.rpc(...)` directly or use `client.rpc.bind(client)` before storing or passing it.",
        },
        schema: [],
        type: "problem",
      },
    },
  },
};

export default wallieSupabasePlugin;
