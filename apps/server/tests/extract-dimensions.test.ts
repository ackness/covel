import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { worldDimensionsSchema } from "@covel/shared";
import { createExtractDimensionsRoute } from "../src/routes/ai/extract-dimensions.js";

// ── Fixtures ──────────────────────────────────────────────────────

const VALID_DIMENSIONS = {
  geography: {
    overview: "A misty harbor city",
    regions: [
      {
        name: "Docklands",
        description: "The bustling port district",
        climate: "Temperate oceanic",
      },
    ],
  },
  factions: [
    {
      id: "merchants-guild",
      name: "Merchants Guild",
      description: "Controls trade routes",
      type: "guild" as const,
      influence: "major" as const,
    },
  ],
  tone: {
    genres: ["fantasy"],
    contentRating: "teen" as const,
  },
};

const SAMPLE_LORE = `
# The City of Mistport

Mistport is a sprawling harbor city shrouded in perpetual fog.
The Docklands district bustles with trade from across the realm.
The Merchants Guild controls all major trade routes, wielding major influence.
The climate is temperate oceanic.
The tone is fantasy, suitable for teen audiences.
`.trim();

// ── Mock AI Stack ─────────────────────────────────────────────────

function createMockAi(responseText: string) {
  return {
    gateway: {
      generateText: vi.fn().mockResolvedValue({ text: responseText }),
    },
  } as any;
}

// ── Helpers ───────────────────────────────────────────────────────

function createApp(ai: any) {
  const app = new Hono();
  app.route("/api/ai/extract-dimensions", createExtractDimensionsRoute(ai));
  return app;
}

async function collectSSE(res: Response): Promise<any[]> {
  const text = await res.text();
  const events: any[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("data:")) {
      try {
        events.push(JSON.parse(line.slice(5).trim()));
      } catch {
        // skip non-JSON lines
      }
    }
  }
  return events;
}

// ── Tests ─────────────────────────────────────────────────────────

describe("POST /api/ai/extract-dimensions", () => {
  describe("input validation", () => {
    it("should reject missing body", async () => {
      const app = createApp(createMockAi("{}"));
      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "not-json",
      });
      expect(res.status).toBe(400);
    });

    it("should reject empty lore", async () => {
      const app = createApp(createMockAi("{}"));
      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: "" }),
      });
      expect(res.status).toBe(400);
    });

    it("should reject lore exceeding max length", async () => {
      const app = createApp(createMockAi("{}"));
      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: "a".repeat(50001) }),
      });
      expect(res.status).toBe(400);
    });
  });

  describe("successful extraction", () => {
    it("should extract dimensions from lore via SSE", async () => {
      const ai = createMockAi(JSON.stringify(VALID_DIMENSIONS));
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      expect(res.status).toBe(200);
      const events = await collectSSE(res);

      // Should have progress + done events
      const progressEvents = events.filter((e) => e.type === "progress");
      const doneEvents = events.filter((e) => e.type === "done");

      expect(progressEvents.length).toBeGreaterThanOrEqual(1);
      expect(doneEvents).toHaveLength(1);

      // Dimensions should be valid
      const dims = doneEvents[0].dimensions;
      expect(dims).toBeDefined();
      const parsed = worldDimensionsSchema.safeParse(dims);
      expect(parsed.success).toBe(true);
    });

    it("should pass lore text to LLM as user message", async () => {
      const ai = createMockAi(JSON.stringify(VALID_DIMENSIONS));
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });
      // Must consume SSE body before checking mock (stream runs async)
      await collectSSE(res);

      expect(ai.gateway.generateText).toHaveBeenCalledOnce();
      const callArgs = ai.gateway.generateText.mock.calls[0][0];
      const userMsg = callArgs.messages.find(
        (m: any) => m.role === "user",
      );
      expect(userMsg?.content).toContain(SAMPLE_LORE);
    });

    it("should use provided locale in system prompt", async () => {
      const ai = createMockAi(JSON.stringify(VALID_DIMENSIONS));
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE, locale: "en-US" }),
      });
      await collectSSE(res);

      const callArgs = ai.gateway.generateText.mock.calls[0][0];
      const sysMsg = callArgs.messages.find(
        (m: any) => m.role === "system",
      );
      expect(sysMsg?.content).toContain("en-US");
    });

    it("should default locale to zh-CN", async () => {
      const ai = createMockAi(JSON.stringify(VALID_DIMENSIONS));
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });
      await collectSSE(res);

      const callArgs = ai.gateway.generateText.mock.calls[0][0];
      const sysMsg = callArgs.messages.find(
        (m: any) => m.role === "system",
      );
      expect(sysMsg?.content).toContain("zh-CN");
    });
  });

  describe("LLM response handling", () => {
    it("should handle JSON wrapped in markdown code fence", async () => {
      const fenced = "```json\n" + JSON.stringify(VALID_DIMENSIONS) + "\n```";
      const ai = createMockAi(fenced);
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      const events = await collectSSE(res);
      const done = events.find((e) => e.type === "done");
      expect(done?.dimensions).toBeDefined();
    });

    it("should emit error event when LLM returns empty response", async () => {
      const ai = createMockAi("");
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      const events = await collectSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.message).toBeTruthy();
    });

    it("should emit error event when LLM returns invalid JSON", async () => {
      const ai = createMockAi("This is not JSON at all");
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      const events = await collectSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
    });

    it("should emit error event when dimensions fail schema validation", async () => {
      const invalidDims = { geography: { regions: [] } }; // regions needs min 1
      const ai = createMockAi(JSON.stringify(invalidDims));
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      const events = await collectSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.message).toContain("validation");
    });

    it("should emit error event when LLM call throws", async () => {
      const ai = {
        gateway: {
          generateText: vi
            .fn()
            .mockRejectedValue(new Error("API key invalid")),
        },
      } as any;
      const app = createApp(ai);

      const res = await app.request("/api/ai/extract-dimensions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lore: SAMPLE_LORE }),
      });

      const events = await collectSSE(res);
      const errorEvent = events.find((e) => e.type === "error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent.message).toContain("API key invalid");
    });
  });
});
