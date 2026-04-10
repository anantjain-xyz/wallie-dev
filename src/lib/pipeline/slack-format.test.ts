import { describe, expect, it } from "vitest";

import type { ProductSpec } from "./types";
import {
  formatEscalationDmBlocks,
  formatPreScreenFailBlocks,
  formatSpecBlocks,
  formatSpecDiffBlocks,
} from "./slack-format";

const baseSpec: ProductSpec = {
  acceptance_criteria: ["Users can log in", "Users see dashboard", "Data persists"],
  constraints: ["Must use SSO"],
  non_goals: ["Mobile support"],
  open_questions: ["Which SSO provider?"],
  problem_statement: "Users can't access the app",
  title: "Login Feature",
  user_story: "As a user, I want to log in so I can use the app.",
};

describe("slack block kit formatting", () => {
  describe("formatSpecBlocks", () => {
    it("includes header, sections, and action buttons", () => {
      const blocks = formatSpecBlocks({
        linearUrl: "https://linear.app/team/issue/TEAM-1",
        pipelineIssueId: "pi-1",
        spec: baseSpec,
        version: 1,
      });

      const types = blocks.map((b) => b.type);
      expect(types).toContain("header");
      expect(types).toContain("section");
      expect(types).toContain("actions");
      expect(types).toContain("context");
    });

    it("embeds pipeline_issue_id and version in action button values", () => {
      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-42",
        spec: baseSpec,
        version: 3,
      });

      const actionsBlock = blocks.find((b) => b.type === "actions") as Record<string, unknown>;
      const elements = actionsBlock.elements as Array<{ value: string }>;
      const approveValue = JSON.parse(elements[0]!.value);

      expect(approveValue.pipeline_issue_id).toBe("pi-42");
      expect(approveValue.version).toBe(3);
    });

    it("includes approve and request changes buttons", () => {
      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-1",
        spec: baseSpec,
        version: 1,
      });

      const actionsBlock = blocks.find((b) => b.type === "actions") as Record<string, unknown>;
      const elements = actionsBlock.elements as Array<{ action_id: string }>;
      const actionIds = elements.map((e) => e.action_id);

      expect(actionIds).toContain("pipeline_approve");
      expect(actionIds).toContain("pipeline_request_changes");
    });

    it("omits context block when no Linear URL", () => {
      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-1",
        spec: baseSpec,
        version: 1,
      });

      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks).toHaveLength(0);
    });

    it("includes Linear URL in context when provided", () => {
      const blocks = formatSpecBlocks({
        linearUrl: "https://linear.app/team/issue/TEAM-1",
        pipelineIssueId: "pi-1",
        spec: baseSpec,
        version: 1,
      });

      const contextBlocks = blocks.filter((b) => b.type === "context");
      expect(contextBlocks).toHaveLength(1);
    });

    it("omits optional sections when arrays are empty", () => {
      const minimalSpec: ProductSpec = {
        ...baseSpec,
        constraints: [],
        non_goals: [],
        open_questions: [],
      };

      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-1",
        spec: minimalSpec,
        version: 1,
      });

      const sectionTexts = blocks
        .filter((b) => b.type === "section")
        .map((b) => {
          const text = b.text as { text: string };
          return text.text;
        });

      expect(sectionTexts.some((t) => t.includes("Constraints"))).toBe(false);
      expect(sectionTexts.some((t) => t.includes("Non-Goals"))).toBe(false);
      expect(sectionTexts.some((t) => t.includes("Open Questions"))).toBe(false);
    });

    it("shows version number in header", () => {
      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-1",
        spec: baseSpec,
        version: 5,
      });

      const header = blocks.find((b) => b.type === "header") as Record<string, unknown>;
      const text = header.text as { text: string };
      expect(text.text).toContain("v5");
    });

    it("escapes Slack mrkdwn link syntax in spec fields", () => {
      // A malicious Linear description that survives the product-agent prompt
      // injection defense and ends up verbatim in a spec field must not turn
      // into a clickable link when rendered into a mrkdwn section. Slack
      // interprets `<url|label>` as a link, so `<`, `>`, `&` must be escaped.
      const hostileSpec: ProductSpec = {
        ...baseSpec,
        acceptance_criteria: ["Valid criterion", "<http://evil.example|Click here>"],
        problem_statement: "See <http://phishing.example|urgent> for details & more",
        title: "Feature <tag> & more",
      };

      const blocks = formatSpecBlocks({
        linearUrl: null,
        pipelineIssueId: "pi-1",
        spec: hostileSpec,
        version: 1,
      });

      const allText = blocks
        .filter((b) => b.type === "header" || b.type === "section")
        .map((b) => (b.text as { text: string }).text)
        .join("\n");

      // Raw link syntax must be gone.
      expect(allText).not.toContain("<http://evil.example|Click here>");
      expect(allText).not.toContain("<http://phishing.example|urgent>");
      // Escaped variants must be present.
      expect(allText).toContain("&lt;http://evil.example|Click here&gt;");
      expect(allText).toContain("&lt;tag&gt;");
      // Ampersand is also escaped.
      expect(allText).toContain("&amp;");
    });
  });

  describe("formatPreScreenFailBlocks", () => {
    it("includes warning and reason", () => {
      const blocks = formatPreScreenFailBlocks("Issue has no description");
      expect(blocks).toHaveLength(1);

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain(":warning:");
      expect(text).toContain("Issue has no description");
    });
  });

  describe("formatEscalationDmBlocks", () => {
    it("includes rejection count and spec title", () => {
      const blocks = formatEscalationDmBlocks({
        channelId: "C123",
        linearUrl: "https://linear.app/team/issue/TEAM-1",
        rejectionCount: 3,
        specTitle: "Login Feature",
        threadTs: "1234567890.123456",
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("Login Feature");
      expect(text).toContain("3 times");
      expect(text).toContain(":rotating_light:");
    });

    it("includes Slack thread link and Linear link in context", () => {
      const blocks = formatEscalationDmBlocks({
        channelId: "C123",
        linearUrl: "https://linear.app/team/issue/TEAM-1",
        rejectionCount: 3,
        specTitle: "Feature",
        threadTs: "1234567890.123456",
      });

      const context = blocks.find((b) => b.type === "context");
      const contextText = (context!.text as { text: string }).text;
      expect(contextText).toContain("slack.com/archives/C123");
      expect(contextText).toContain("linear.app");
    });

    it("omits Linear link when null", () => {
      const blocks = formatEscalationDmBlocks({
        channelId: "C123",
        linearUrl: null,
        rejectionCount: 3,
        specTitle: "Feature",
        threadTs: "1234567890.123456",
      });

      const context = blocks.find((b) => b.type === "context");
      const contextText = (context!.text as { text: string }).text;
      expect(contextText).not.toContain("linear.app");
    });
  });

  describe("formatSpecDiffBlocks", () => {
    it("detects problem statement changes", () => {
      const blocks = formatSpecDiffBlocks({
        newSpec: { ...baseSpec, problem_statement: "Updated problem" },
        oldSpec: baseSpec,
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("Problem statement updated");
    });

    it("detects user story changes", () => {
      const blocks = formatSpecDiffBlocks({
        newSpec: { ...baseSpec, user_story: "New story" },
        oldSpec: baseSpec,
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("User story updated");
    });

    it("counts added and removed acceptance criteria", () => {
      const blocks = formatSpecDiffBlocks({
        newSpec: {
          ...baseSpec,
          acceptance_criteria: ["Users can log in", "New criterion A", "New criterion B"],
        },
        oldSpec: baseSpec,
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("Added 2 acceptance criteria");
      expect(text).toContain("Removed 2 acceptance criteria");
    });

    it("counts added and removed constraints", () => {
      const blocks = formatSpecDiffBlocks({
        newSpec: { ...baseSpec, constraints: ["Must use SSO", "Must support SAML"] },
        oldSpec: baseSpec,
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("Added 1 constraints");
    });

    it("shows minor wording changes when nothing differs structurally", () => {
      const blocks = formatSpecDiffBlocks({
        newSpec: baseSpec,
        oldSpec: baseSpec,
      });

      const text = (blocks[0]!.text as { text: string }).text;
      expect(text).toContain("Minor wording changes");
    });
  });
});
