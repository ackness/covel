// @vitest-environment jsdom

import React, { type ComponentType, createElement, useState } from "react";
import {
  cleanup,
  screen,
  waitFor
} from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadWebModule } from "./helpers/load-web-module.js";
import { renderWithI18n } from "./helpers/render-with-i18n.js";

interface PresetRecord {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  baseUrl?: string;
  apiKey?: string;
}

interface PresetEditorProps {
  presets: PresetRecord[];
  onSave(input: {
    presetId: string;
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }): Promise<void> | void;
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
  it("renders preset data without exposing provider api keys in plaintext", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const hiddenApiKey = "sk-live-super-secret";

    renderWithI18n(createElement(PresetEditor, {
      presets: [
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
      ],
      onSave() {}
    }));

    await screen.findByText("Default story");
    expect(screen.getByText("Story alt")).toBeTruthy();
    expect(screen.queryByText(hiddenApiKey)).toBeNull();
    expect(screen.queryByDisplayValue(hiddenApiKey)).toBeNull();
  });

  it("edits model, enabled, and isDefault fields without touching routing or secret material", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const handleSave = vi.fn(async () => {});
    const user = userEvent.setup();

    renderWithI18n(createElement(PresetEditor, {
      presets: [
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
      ],
      onSave: handleSave
    }));

    await screen.findByText("Story alt");
    await user.click(screen.getByRole("button", { name: "编辑 Story alt" }));
    await user.clear(screen.getByLabelText("模型"));
    await user.type(screen.getByLabelText("模型"), "qwen-max-latest");
    expect(screen.queryByLabelText("基础 URL")).toBeNull();
    await user.click(screen.getByLabelText("已启用"));
    await user.click(screen.getByLabelText("默认预设"));
    await user.click(screen.getByRole("button", { name: "保存预设" }));

    expect(handleSave).toHaveBeenCalledWith({
      presetId: "story-alt",
      model: "qwen-max-latest",
      enabled: false,
      isDefault: true
    });
  });

  it("refreshes the visible preset state after save completes", async () => {
    const { PresetEditor } = await loadWebModule<PresetEditorModule>("components/preset-editor.ts");
    const updatedPreset = createPresetFixture({
      id: "story-alt",
      name: "Story alt",
      model: "qwen-max-latest",
      baseUrl: "https://router.example/v1",
      enabled: false,
      isDefault: true,
      scope: "project"
    });
    const user = userEvent.setup();

    function TestHarness() {
      const [presets, setPresets] = useState<PresetRecord[]>([
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
      ]);

      return createElement(PresetEditor, {
        presets,
        onSave: async (input) => {
          setPresets((current) =>
            current.map((preset) =>
              preset.id === input.presetId
                ? {
                    ...preset,
                    ...updatedPreset
                  }
                : updatedPreset.isDefault
                  ? {
                      ...preset,
                      isDefault: false
                    }
                  : preset
            )
          );
        }
      });
    }

    renderWithI18n(createElement(TestHarness));

    await screen.findByText("Story alt");
    await user.click(screen.getByRole("button", { name: "编辑 Story alt" }));
    await user.clear(screen.getByLabelText("模型"));
    await user.type(screen.getByLabelText("模型"), updatedPreset.model);
    expect(screen.queryByLabelText("基础 URL")).toBeNull();
    await user.click(screen.getByLabelText("已启用"));
    await user.click(screen.getByLabelText("默认预设"));
    await user.click(screen.getByRole("button", { name: "保存预设" }));

    await waitFor(() => {
      expect(screen.getByDisplayValue("qwen-max-latest")).toBeTruthy();
      expect(screen.getByText("已停用")).toBeTruthy();
      expect(screen.getAllByText("默认").length).toBeGreaterThan(0);
    });
  });
});
