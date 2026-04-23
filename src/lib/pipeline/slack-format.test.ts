import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PipelineStage } from "@/features/sessions/types";
import {
  escapeMrkdwn,
  formatEscalationDmBlocks,
  formatGenerationFailureBlocks,
  formatStageReviewBlocks,
  openSlackDm,
  openSlackView,
  postSlackMessage,
  updateSlackMessage,
} from "./slack-format";

const stage: Pick<PipelineStage, "name"> = { name: "Engineering" };
const nextStage: Pick<PipelineStage, "name"> = { name: "Review" };

describe("slack block kit formatting", () => {
  describe("formatStageReviewBlocks", () => {
    it("includes header, sections, and approve/reject action buttons", () => {
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: "# Implementation\n\nDone.",
        linearUrl: "https://linear.app/team/issue/TEAM-1",
        nextStage,
        sessionId: "s-1",
        stage,
        version: 1,
      });

      const types = blocks.map((b) => b.type);
      expect(types).toContain("header");
      expect(types).toContain("section");
      expect(types).toContain("actions");
      expect(types).toContain("context");
    });

    it("embeds session_id and version in action button values", () => {
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: "x",
        linearUrl: null,
        nextStage,
        sessionId: "s-42",
        stage,
        version: 3,
      });

      const actionsBlock = blocks.find((b) => b.type === "actions") as Record<string, unknown>;
      const elements = actionsBlock.elements as Array<{ value: string; action_id: string }>;
      const approveValue = JSON.parse(elements[0]!.value);

      expect(approveValue.session_id).toBe("s-42");
      expect(approveValue.version).toBe(3);
      const ids = elements.map((e) => e.action_id);
      expect(ids).toContain("pipeline_approve");
      expect(ids).toContain("pipeline_request_changes");
    });

    it("omits the context block when no Linear URL", () => {
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: "x",
        linearUrl: null,
        nextStage,
        sessionId: "s-1",
        stage,
        version: 1,
      });
      expect(blocks.find((b) => b.type === "context")).toBeUndefined();
    });

    it("falls back to 'completion' when there is no next stage", () => {
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: "x",
        linearUrl: null,
        nextStage: null,
        sessionId: "s-1",
        stage,
        version: 1,
      });
      const sections = blocks.filter((b) => b.type === "section") as Array<{
        text: { text: string };
      }>;
      const advanceText = sections[0]!.text.text;
      expect(advanceText).toContain("completion");
    });

    it("escapes mrkdwn in the artifact preview", () => {
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: "<script>",
        linearUrl: null,
        nextStage,
        sessionId: "s-1",
        stage,
        version: 1,
      });
      const sections = blocks.filter((b) => b.type === "section") as Array<{
        text: { text: string };
      }>;
      const previewBlock = sections[1]!;
      expect(previewBlock.text.text).toContain("&lt;script&gt;");
    });

    it("truncates very long artifact previews", () => {
      const longArtifact = "x".repeat(5000);
      const blocks = formatStageReviewBlocks({
        artifactPreviewMd: longArtifact,
        linearUrl: null,
        nextStage,
        sessionId: "s-1",
        stage,
        version: 1,
      });
      const sections = blocks.filter((b) => b.type === "section") as Array<{
        text: { text: string };
      }>;
      const previewBlock = sections[1]!;
      expect(previewBlock.text.text.length).toBeLessThan(longArtifact.length);
      expect(previewBlock.text.text).toContain("…");
    });
  });

  describe("formatGenerationFailureBlocks", () => {
    it("escapes the stage name", () => {
      const blocks = formatGenerationFailureBlocks("<dangerous>");
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("&lt;dangerous&gt;");
    });
  });

  describe("formatEscalationDmBlocks", () => {
    it("includes the rejection count and stage name", () => {
      const blocks = formatEscalationDmBlocks({
        channelId: "C123",
        linearUrl: null,
        rejectionCount: 3,
        sessionTitle: "Session A",
        stageName: "Review",
        threadTs: "1234.5678",
      });
      const text = (blocks[0] as { text: { text: string } }).text.text;
      expect(text).toContain("Session A");
      expect(text).toContain("Review");
      expect(text).toContain("3 times");
    });
  });

  describe("escapeMrkdwn", () => {
    it("escapes &, <, > in order", () => {
      expect(escapeMrkdwn("a & b")).toBe("a &amp; b");
      expect(escapeMrkdwn("<a>")).toBe("&lt;a&gt;");
      expect(escapeMrkdwn("a&<b>")).toBe("a&amp;&lt;b&gt;");
    });
  });

  describe("Slack API helpers", () => {
    const fetchMock = vi.fn();
    beforeEach(() => {
      fetchMock.mockReset();
      vi.stubGlobal("fetch", fetchMock);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("postSlackMessage throws on ok:false", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: false, error: "channel_not_found" }), { status: 200 }),
      );
      await expect(
        postSlackMessage({
          blocks: [],
          botToken: "x",
          channel: "C1",
          text: "hi",
        }),
      ).rejects.toThrow(/channel_not_found/);
    });

    it("postSlackMessage returns ts on success", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, ts: "111.222" }), { status: 200 }),
      );
      const result = await postSlackMessage({
        blocks: [],
        botToken: "x",
        channel: "C1",
        text: "hi",
      });
      expect(result.ts).toBe("111.222");
    });

    it("openSlackDm returns the channel id", async () => {
      fetchMock.mockResolvedValue(
        new Response(JSON.stringify({ ok: true, channel: { id: "D777" } }), { status: 200 }),
      );
      const id = await openSlackDm({ botToken: "x", userId: "U1" });
      expect(id).toBe("D777");
    });

    it("updateSlackMessage / openSlackView throw on HTTP failure", async () => {
      fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
      await expect(
        updateSlackMessage({ blocks: [], botToken: "x", channel: "C1", text: "x", ts: "1" }),
      ).rejects.toThrow(/HTTP 500/);
      await expect(openSlackView({ botToken: "x", triggerId: "t", view: {} })).rejects.toThrow(
        /HTTP 500/,
      );
    });
  });
});
