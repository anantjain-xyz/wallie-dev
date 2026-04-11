import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ProductSpec } from "./types";
import {
  formatEscalationDmBlocks,
  formatPreScreenFailBlocks,
  formatSpecBlocks,
  formatSpecDiffBlocks,
  openSlackDm,
  openSlackView,
  postSlackMessage,
  updateSlackMessage,
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

      // Section blocks are mrkdwn — hostile `<url|label>` must be escaped to
      // `&lt;...&gt;` so Slack doesn't render a clickable link.
      const sectionText = blocks
        .filter((b) => b.type === "section")
        .map((b) => (b.text as { text: string }).text)
        .join("\n");

      expect(sectionText).not.toContain("<http://evil.example|Click here>");
      expect(sectionText).not.toContain("<http://phishing.example|urgent>");
      expect(sectionText).toContain("&lt;http://evil.example|Click here&gt;");
      expect(sectionText).toContain("&amp;");

      // The header block is plain_text — Slack does not interpret `<...>` as
      // a link in plain_text, so hostile characters render literally and do
      // not need to be HTML-escaped. Assert the title is passed through raw.
      const header = blocks.find((b) => b.type === "header") as Record<string, unknown>;
      const headerText = (header.text as { text: string; type: string }).text;
      expect((header.text as { type: string }).type).toBe("plain_text");
      expect(headerText).toContain("<tag>");
      expect(headerText).toContain("&");
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

      const context = blocks.find((b) => b.type === "context") as Record<string, unknown>;
      const elements = context.elements as Array<{ text: string; type: string }>;
      const contextText = elements[0]!.text;
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

      const context = blocks.find((b) => b.type === "context") as Record<string, unknown>;
      const elements = context.elements as Array<{ text: string; type: string }>;
      const contextText = elements[0]!.text;
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

  describe("Slack API helpers fail closed on ok:false", () => {
    // Slack Web API returns HTTP 200 with `{ ok: false, error: "..." }` for
    // logical failures (invalid_auth, missing_scope, channel_not_found,
    // thread_not_found, invalid_blocks, etc.). The Phase 1 helpers used to
    // return the raw body and every caller forgot to check `ok`, so a failed
    // post silently advanced pipeline state. These tests pin the new
    // throw-on-ok:false contract so regressions surface loudly.
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = vi.fn();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
      vi.clearAllMocks();
    });

    function mockSlackResponse(body: unknown, httpOk = true) {
      (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        json: async () => body,
        ok: httpOk,
        status: httpOk ? 200 : 500,
      });
    }

    it("postSlackMessage throws when Slack returns ok:false", async () => {
      mockSlackResponse({ error: "channel_not_found", ok: false });

      await expect(
        postSlackMessage({
          blocks: [{ text: { text: "hi", type: "mrkdwn" }, type: "section" }],
          botToken: "xoxb-test",
          channel: "C-gone",
          text: "hi",
        }),
      ).rejects.toThrow(/channel_not_found/);
    });

    it("postSlackMessage returns ts on ok:true", async () => {
      mockSlackResponse({ ok: true, ts: "1700000000.123456" });

      const result = await postSlackMessage({
        blocks: [],
        botToken: "xoxb-test",
        channel: "C-1",
        text: "hi",
      });
      expect(result.ts).toBe("1700000000.123456");
    });

    it("postSlackMessage throws on non-2xx HTTP", async () => {
      mockSlackResponse({ error: "server_error", ok: false }, false);

      await expect(
        postSlackMessage({
          blocks: [],
          botToken: "xoxb-test",
          channel: "C-1",
          text: "hi",
        }),
      ).rejects.toThrow(/HTTP 500/);
    });

    it("updateSlackMessage throws on ok:false", async () => {
      mockSlackResponse({ error: "message_not_found", ok: false });

      await expect(
        updateSlackMessage({
          blocks: [],
          botToken: "xoxb-test",
          channel: "C-1",
          text: "updated",
          ts: "1700000000.000001",
        }),
      ).rejects.toThrow(/message_not_found/);
    });

    it("openSlackDm throws on ok:false", async () => {
      mockSlackResponse({ error: "user_not_found", ok: false });

      await expect(
        openSlackDm({
          botToken: "xoxb-test",
          userId: "U-ghost",
        }),
      ).rejects.toThrow(/user_not_found/);
    });

    it("openSlackDm throws when ok:true but channel.id missing", async () => {
      mockSlackResponse({ channel: {}, ok: true });

      await expect(
        openSlackDm({
          botToken: "xoxb-test",
          userId: "U-1",
        }),
      ).rejects.toThrow(/no channel\.id/);
    });

    it("openSlackDm returns the DM channel id on ok:true", async () => {
      mockSlackResponse({ channel: { id: "D-12345" }, ok: true });

      const result = await openSlackDm({
        botToken: "xoxb-test",
        userId: "U-1",
      });
      expect(result).toBe("D-12345");
    });

    it("openSlackView throws on ok:false (e.g. expired trigger)", async () => {
      mockSlackResponse({ error: "expired_trigger_id", ok: false });

      await expect(
        openSlackView({
          botToken: "xoxb-test",
          triggerId: "trigger-old",
          view: { type: "modal" },
        }),
      ).rejects.toThrow(/expired_trigger_id/);
    });
  });
});
