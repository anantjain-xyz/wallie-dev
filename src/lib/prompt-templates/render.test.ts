import { describe, expect, it } from "vitest";

import { renderTemplate } from "./render";

describe("renderTemplate", () => {
  it("replaces simple variables", () => {
    const result = renderTemplate("Hello {{name}}", { name: "World" });
    expect(result).toBe("Hello World");
  });

  it("replaces dot-notation variables", () => {
    const result = renderTemplate("Hello {{user.name}}", {
      user: { name: "Alice" },
    });
    expect(result).toBe("Hello Alice");
  });

  it("replaces multiple variables", () => {
    const result = renderTemplate("{{greeting}} {{name}}!", {
      greeting: "Hi",
      name: "Bob",
    });
    expect(result).toBe("Hi Bob!");
  });

  it("replaces missing variables with empty string", () => {
    const result = renderTemplate("Hello {{name}}", {});
    expect(result).toBe("Hello ");
  });

  it("replaces null variables with empty string", () => {
    const result = renderTemplate("Hello {{name}}", { name: null });
    expect(result).toBe("Hello ");
  });

  it("handles array variables by joining with newlines", () => {
    const result = renderTemplate("Items: {{items}}", {
      items: ["a", "b", "c"],
    });
    expect(result).toBe("Items: a\nb\nc");
  });

  it("handles conditional blocks - truthy", () => {
    const result = renderTemplate("{{#if show}}visible{{/if}}", { show: true });
    expect(result).toBe("visible");
  });

  it("handles conditional blocks - falsy", () => {
    const result = renderTemplate("before{{#if show}}visible{{/if}}after", { show: false });
    expect(result).toBe("beforeafter");
  });

  it("handles conditional blocks with missing variable", () => {
    const result = renderTemplate("before{{#if missing}}visible{{/if}}after", {});
    expect(result).toBe("beforeafter");
  });

  it("handles conditional blocks with empty string", () => {
    const result = renderTemplate("{{#if feedback}}Feedback: {{feedback}}{{/if}}", {
      feedback: "",
    });
    expect(result).toBe("");
  });

  it("handles conditional blocks with content", () => {
    const result = renderTemplate("{{#if feedback}}Feedback: {{feedback}}{{/if}}", {
      feedback: "looks good",
    });
    expect(result).toBe("Feedback: looks good");
  });

  it("handles nested variable resolution inside conditionals", () => {
    const result = renderTemplate("{{#if attempt.feedback}}Previous: {{attempt.feedback}}{{/if}}", {
      attempt: { feedback: "fix the bug" },
    });
    expect(result).toBe("Previous: fix the bug");
  });

  it("handles empty array as falsy in conditionals", () => {
    const result = renderTemplate("{{#if items}}has items{{/if}}", { items: [] });
    expect(result).toBe("");
  });

  it("handles numeric zero as truthy", () => {
    const result = renderTemplate("{{count}}", { count: 0 });
    expect(result).toBe("0");
  });

  it("handles complex template with multiple features", () => {
    const template = `# {{session.title}}

{{session.prompt}}

{{#if artifact.productSpec}}## Product Spec

{{artifact.productSpec}}
{{/if}}

{{#if attempt.feedback}}## Feedback

{{attempt.feedback}}
{{/if}}`;

    const result = renderTemplate(template, {
      session: { title: "Add auth", prompt: "Add login flow" },
      artifact: { productSpec: "Users need to log in" },
      attempt: { feedback: "" },
    });

    expect(result).toContain("# Add auth");
    expect(result).toContain("Add login flow");
    expect(result).toContain("Users need to log in");
    expect(result).not.toContain("Feedback");
  });
});
