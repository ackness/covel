import { describe, it, expect } from "vitest";
import {
  candidateListPropsSchema,
  mediaGalleryPropsSchema,
  entryListPropsSchema,
  jobListPropsSchema,
  graphCanvasPropsSchema,
} from "@covel/shared";

/**
 * Catalog schema validation test suite
 *
 * Ensures all 5 catalog schemas accept valid minimal input and reject invalid shapes.
 * Component rendering tests are covered by integration tests in their respective feature areas.
 */

describe("Catalog Component Schemas", () => {
  describe("CandidateList schema", () => {
    it("accepts valid minimal props", () => {
      const result = candidateListPropsSchema.safeParse({
        candidates: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts full props with optional fields", () => {
      const result = candidateListPropsSchema.safeParse({
        candidates: [{ id: "1", content: "test", source: "runtime" }],
        idField: "id",
        contentField: "content",
        turnId: "turn-1",
        acceptedId: "1",
        acceptAction: {
          pluginId: "test",
          runtimeId: "test/action",
          payload: {},
        },
        regenerateAction: {
          pluginId: "test",
          runtimeId: "test/regenerate",
          payload: {},
        },
        detailFields: ["source"],
        hiddenWhen: { field: "hidden", equals: true },
      });
      expect(result.success).toBe(true);
    });

    it("uses defaults for idField and contentField", () => {
      const result = candidateListPropsSchema.safeParse({
        candidates: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.idField).toBe("id");
        expect(result.data.contentField).toBe("content");
      }
    });
  });

  describe("MediaGallery schema", () => {
    it("accepts valid minimal props", () => {
      const result = mediaGalleryPropsSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts full props with optional fields", () => {
      const result = mediaGalleryPropsSchema.safeParse({
        items: [
          { id: "1", ref: { id: "media-1", url: "/test.png", type: "image" } },
        ],
        idField: "id",
        refField: "ref",
        titleField: "title",
        statusField: "status",
        errorField: "error",
        durationField: "duration",
        fields: [{ path: "prompt", label: "Prompt" }],
        rerunAction: {
          pluginId: "test",
          runtimeId: "test/rerun",
          payload: {},
        },
      });
      expect(result.success).toBe(true);
    });

    it("uses defaults for idField and refField", () => {
      const result = mediaGalleryPropsSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.idField).toBe("id");
        expect(result.data.refField).toBe("ref");
      }
    });
  });

  describe("EntryList schema", () => {
    it("accepts valid minimal props", () => {
      const result = entryListPropsSchema.safeParse({
        items: [],
        titleField: "title",
      });
      expect(result.success).toBe(true);
    });

    it("accepts full props with optional fields", () => {
      const result = entryListPropsSchema.safeParse({
        items: [{ id: "1", title: "Test", description: "desc" }],
        idField: "id",
        titleField: "title",
        descriptionFields: ["description", "summary"],
        badgeFields: ["tags"],
        dateField: "createdAt",
        footerField: "metadata",
        fields: [{ path: "status", label: "Status" }],
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing titleField", () => {
      const result = entryListPropsSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(false);
    });
  });

  describe("JobList schema", () => {
    it("accepts valid minimal props", () => {
      const result = jobListPropsSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(true);
    });

    it("accepts full props with optional fields", () => {
      const result = jobListPropsSchema.safeParse({
        items: [{ id: "job-1", status: "completed" }],
        idField: "jobId",
        statusField: "status",
        durationField: "duration",
        messageField: "message",
        errorField: "error",
        fields: [{ path: "prompt", label: "Prompt" }],
        rerunAction: {
          pluginId: "test",
          runtimeId: "test/rerun",
          payload: {},
        },
        relatedMedia: {
          items: [],
          itemField: "jobId",
          matchField: "id",
          idField: "id",
          refField: "ref",
          titleField: "title",
        },
      });
      expect(result.success).toBe(true);
    });

    it("uses defaults for field names", () => {
      const result = jobListPropsSchema.safeParse({
        items: [],
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.idField).toBe("jobId");
        expect(result.data.statusField).toBe("status");
        expect(result.data.messageField).toBe("message");
        expect(result.data.errorField).toBe("error");
        expect(result.data.durationField).toBe("durationMs");
      }
    });
  });

  describe("GraphCanvas schema", () => {
    it("accepts valid minimal props", () => {
      const result = graphCanvasPropsSchema.safeParse({
        nodes: [],
        edges: [],
        node: {
          idField: "id",
          labelField: "label",
          typeField: "type",
          summaryField: "summary",
          labelsField: "labels",
          colors: { character: "#ff0000" },
          defaultColor: "#cccccc",
        },
        edge: {
          idField: "id",
          sourceField: "source",
          targetField: "target",
          relationField: "relation",
          strengthField: "strength",
          factField: "fact",
          inactiveField: "inactive",
          colors: {
            positive: "#00ff00",
            negative: "#ff0000",
            neutral: "#cccccc",
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it("accepts optional height", () => {
      const result = graphCanvasPropsSchema.safeParse({
        nodes: [],
        edges: [],
        node: {
          idField: "id",
          labelField: "label",
          typeField: "type",
          summaryField: "summary",
          labelsField: "labels",
          colors: {},
          defaultColor: "#ccc",
        },
        edge: {
          idField: "id",
          sourceField: "source",
          targetField: "target",
          relationField: "relation",
          strengthField: "strength",
          factField: "fact",
          inactiveField: "inactive",
          colors: { positive: "#0f0", negative: "#f00", neutral: "#ccc" },
        },
        height: 600,
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.height).toBe(600);
      }
    });

    it("uses default height", () => {
      const result = graphCanvasPropsSchema.safeParse({
        nodes: [],
        edges: [],
        node: {
          idField: "id",
          labelField: "label",
          typeField: "type",
          summaryField: "summary",
          labelsField: "labels",
          colors: {},
          defaultColor: "#ccc",
        },
        edge: {
          idField: "id",
          sourceField: "source",
          targetField: "target",
          relationField: "relation",
          strengthField: "strength",
          factField: "fact",
          inactiveField: "inactive",
          colors: { positive: "#0f0", negative: "#f00", neutral: "#ccc" },
        },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.height).toBe(480);
      }
    });

    it("rejects extra properties (strictObject)", () => {
      const result = graphCanvasPropsSchema.safeParse({
        nodes: [],
        edges: [],
        node: {
          idField: "id",
          labelField: "label",
          typeField: "type",
          summaryField: "summary",
          labelsField: "labels",
          colors: {},
          defaultColor: "#ccc",
        },
        edge: {
          idField: "id",
          sourceField: "source",
          targetField: "target",
          relationField: "relation",
          strengthField: "strength",
          factField: "fact",
          inactiveField: "inactive",
          colors: { positive: "#0f0", negative: "#f00", neutral: "#ccc" },
        },
        unknownField: "not allowed",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing required node fields", () => {
      const result = graphCanvasPropsSchema.safeParse({
        nodes: [],
        edges: [],
        node: {
          idField: "id",
          // missing other required fields
        },
        edge: {
          idField: "id",
          sourceField: "source",
          targetField: "target",
          relationField: "relation",
          strengthField: "strength",
          factField: "fact",
          inactiveField: "inactive",
          colors: { positive: "#0f0", negative: "#f00", neutral: "#ccc" },
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
