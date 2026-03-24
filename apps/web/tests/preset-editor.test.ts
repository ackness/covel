// @vitest-environment jsdom

import React, { type ComponentType, createElement } from "react";
import {
  cleanup,
  render,
  screen,
  waitFor
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PresetMetadata } from "../../../modules/model-gateway/src/model-profile-registry.js";
import {
  createJsonResponse,
  installFetchStub
} from "./helpers/fetch-stub.js";
import { loadWebModule } from "./helpers/load-web-module.js";

type PresetRecord = PresetMetadata & {
  apiKey?: string;
};

interface PresetEditorProps {
  runtimeBaseUrl: string;
}

interface PresetEditorModule {
  PresetEditor: ComponentType<PresetEditorProps>;
}

function createPresetFixture(overrides: Partial<PresetRecord> = {}): PresetRecord {
  return {
    id: "default-story",
    name: "Default story",
    provider: "openaiCompatible",
    model: "qwen-plus",
    tier: "medium",
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    supportedModes: ["text", "object", "stream"],
    enabled: true,
    isDefault: true,
    scope: "global",
    ...overrides
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("apps/web PresetEditor", () => {
  it("loads the preset list and never renders provider api keys in plaintext", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const hiddenApiKey = "sk-live-super-secret";
    const fetchStub = installFetchStub([
      {
        method: "GET",
        url: "http://runtime.test/presets",
        handler: async () => createJsonResponse([
          createPresetFixture({
            apiKey: hiddenApiKey
          }),
          createPresetFixture({
            id: "story-alt",
            name: "Story alt",
            model: "qwen-turbo",
            enabled: false,
            isDefault: false,
            scope: "project",
            apiKey: hiddenApiKey
          })
        ])
      }
    ]);

    render(createElement(PresetEditor, {
      runtimeBaseUrl: "http://runtime.test"
    }));

    await screen.findByText("Default story");
    expect(screen.getByText("Story alt")).toBeTruthy();
    expect(screen.queryByText(hiddenApiKey)).toBeNull();
    expect(screen.queryByDisplayValue(hiddenApiKey)).toBeNull();

    fetchStub.restore();
  });

  it("edits model, baseUrl, enabled, and isDefault fields without touching secret material", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const fetchStub = installFetchStub([
      {
        method: "GET",
        url: "http://runtime.test/presets",
        handler: async () => createJsonResponse([
          createPresetFixture(),
          createPresetFixture({
            id: "story-alt",
            name: "Story alt",
            model: "qwen-turbo",
            baseUrl: "https://router.example/v1",
            enabled: true,
            isDefault: false,
            scope: "project"
          })
        ])
      },
      {
        method: "PUT",
        url: "http://runtime.test/presets/story-alt",
        handler: async () => createJsonResponse(
          createPresetFixture({
            id: "story-alt",
            name: "Story alt",
            model: "qwen-max-latest",
            baseUrl: "https://openrouter.example/api/v1",
            enabled: false,
            isDefault: true,
            scope: "project"
          })
        )
      }
    ]);
    const user = userEvent.setup();

    render(createElement(PresetEditor, {
      runtimeBaseUrl: "http://runtime.test"
    }));

    await screen.findByText("Story alt");
    await user.click(screen.getByRole("button", { name: "Edit Story alt" }));
    await user.clear(screen.getByLabelText("Model"));
    await user.type(screen.getByLabelText("Model"), "qwen-max-latest");
    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), "https://openrouter.example/api/v1");
    await user.click(screen.getByLabelText("Enabled"));
    await user.click(screen.getByLabelText("Default preset"));
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    await expect(fetchStub.calls[1]?.json()).resolves.toMatchObject({
      model: "qwen-max-latest",
      baseUrl: "https://openrouter.example/api/v1",
      enabled: false,
      isDefault: true
    });
    await expect(fetchStub.calls[1]?.json()).resolves.not.toHaveProperty("apiKey");

    fetchStub.restore();
  });

  it("refreshes the visible preset state after save completes", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const updatedPreset = createPresetFixture({
      id: "story-alt",
      name: "Story alt",
      model: "qwen-max-latest",
      baseUrl: "https://openrouter.example/api/v1",
      enabled: false,
      isDefault: true,
      scope: "project"
    });
    const fetchStub = installFetchStub([
      {
        method: "GET",
        url: "http://runtime.test/presets",
        handler: async () => createJsonResponse([
          createPresetFixture(),
          createPresetFixture({
            id: "story-alt",
            name: "Story alt",
            model: "qwen-turbo",
            baseUrl: "https://router.example/v1",
            enabled: true,
            isDefault: false,
            scope: "project"
          })
        ])
      },
      {
        method: "PUT",
        url: "http://runtime.test/presets/story-alt",
        handler: async () => createJsonResponse(updatedPreset)
      }
    ]);
    const user = userEvent.setup();

    render(createElement(PresetEditor, {
      runtimeBaseUrl: "http://runtime.test"
    }));

    await screen.findByText("Story alt");
    await user.click(screen.getByRole("button", { name: "Edit Story alt" }));
    await user.clear(screen.getByLabelText("Model"));
    await user.type(screen.getByLabelText("Model"), updatedPreset.model);
    await user.clear(screen.getByLabelText("Base URL"));
    await user.type(screen.getByLabelText("Base URL"), updatedPreset.baseUrl ?? "");
    await user.click(screen.getByLabelText("Enabled"));
    await user.click(screen.getByLabelText("Default preset"));
    await user.click(screen.getByRole("button", { name: "Save preset" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("qwen-max-latest")).toBeTruthy();
      expect(screen.getByDisplayValue("https://openrouter.example/api/v1")).toBeTruthy();
      expect(screen.getByText("Disabled")).toBeTruthy();
      expect(screen.getAllByText("Default").length).toBeGreaterThan(0);
    });

    fetchStub.restore();
  });
});
