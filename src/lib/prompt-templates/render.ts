/**
 * Simple Mustache-style template renderer.
 *
 * Supports:
 *   {{variable}}          — replaced with the variable value
 *   {{object.property}}   — dot-notation access
 *   {{#if variable}}...{{/if}}  — conditional blocks (truthy check)
 *
 * This is intentionally minimal. If full Liquid support is needed later,
 * swap this module for the `liquidjs` package.
 */

export type TemplateVariables = Record<string, unknown>;

/**
 * Render a template string by replacing {{variable}} placeholders
 * with values from the provided variables map.
 */
export function renderTemplate(template: string, variables: TemplateVariables): string {
  let result = template;

  // Process conditional blocks: {{#if var}}...{{/if}}
  result = result.replace(
    /\{\{#if\s+([a-zA-Z0-9_.]+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (_match, key: string, body: string) => {
      const value = resolveVariable(key, variables);
      if (isTruthy(value)) {
        // Recursively render the body so nested variables are resolved.
        return renderTemplate(body, variables);
      }
      return "";
    },
  );

  // Replace {{variable}} and {{object.property}} placeholders.
  result = result.replace(/\{\{([a-zA-Z0-9_.]+)\}\}/g, (_match, key: string) => {
    const value = resolveVariable(key, variables);
    if (value === undefined || value === null) return "";
    if (Array.isArray(value)) return value.join("\n");
    return String(value);
  });

  return result;
}

/**
 * Resolve a dot-notation variable path against the variables map.
 */
function resolveVariable(path: string, variables: TemplateVariables): unknown {
  const parts = path.split(".");
  let current: unknown = variables;

  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

function isTruthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === "") return false;
  if (Array.isArray(value) && value.length === 0) return false;
  return true;
}
