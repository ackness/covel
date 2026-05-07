import { describe, expect, it } from "vitest";
import {
  createGalleryPreset,
  createJobsPreset,
  galleryPreset,
  jobsPreset,
} from "../src/json-render-presets/index.js";

describe("json-render presets", () => {
  it("builds a reusable gallery panel preset", () => {
    const preset = createGalleryPreset({
      namespace: "images",
      groupOrder: 610,
    });

    expect(preset.id).toBe("media-gallery");
    expect(preset.group).toBe("media");
    expect(preset.groupOrder).toBe(610);
    expect(preset.dataSource.namespace).toBe("images");
    expect(preset.emptyState.message).toMatchObject({
      zh: expect.any(String),
      en: expect.any(String),
    });
    expect(preset.view).toMatchObject({
      component: "CardList",
      repeat: { statePath: "/entries", key: "key" },
    });
    expect(JSON.stringify(preset.view)).toContain('"component":"Media"');
  });

  it("builds a reusable jobs panel preset for the reserved namespace", () => {
    const preset = createJobsPreset();

    expect(preset.id).toBe("background-jobs");
    expect(preset.dataSource.namespace).toBe("_jobs");
    expect(preset.label).toMatchObject({
      zh: expect.any(String),
      en: expect.any(String),
    });
    expect(JSON.stringify(preset.view)).toContain('"value/status"');
    expect(JSON.stringify(preset.view)).toContain('"value/error"');
  });

  it("exports default preset instances", () => {
    expect(galleryPreset.dataSource.namespace).toBe("images");
    expect(jobsPreset.dataSource.namespace).toBe("_jobs");
  });
});
