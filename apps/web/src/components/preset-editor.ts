import React, { createElement, useEffect, useState } from "react";

import type { PresetMetadata } from "../../../../modules/model-gateway/src/index.js";

type EditablePreset = PresetMetadata & {
  apiKey?: string;
};

export function PresetEditor(input: {
  runtimeBaseUrl: string;
}) {
  const [presets, setPresets] = useState<EditablePreset[]>([]);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [formState, setFormState] = useState<{
    model: string;
    baseUrl: string;
    enabled: boolean;
    isDefault: boolean;
  }>({
    model: "",
    baseUrl: "",
    enabled: true,
    isDefault: false
  });

  useEffect(() => {
    void loadPresets();
  }, []);

  async function loadPresets() {
    const response = await fetch(`${input.runtimeBaseUrl}/presets`);
    const payload = await response.json() as EditablePreset[];
    setPresets(payload);
  }

  function beginEdit(preset: EditablePreset) {
    setEditingPresetId(preset.id);
    setFormState({
      model: preset.model,
      baseUrl: preset.baseUrl ?? "",
      enabled: preset.enabled,
      isDefault: preset.isDefault
    });
  }

  async function savePreset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPresetId) {
      return;
    }

    const response = await fetch(`${input.runtimeBaseUrl}/presets/${editingPresetId}`, {
      method: "PUT",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: formState.model,
        baseUrl: formState.baseUrl,
        enabled: formState.enabled,
        isDefault: formState.isDefault
      })
    });
    const updatedPreset = await response.json() as EditablePreset;

    setPresets((current) =>
      current.map((preset) => (preset.id === editingPresetId ? updatedPreset : preset))
    );
    setFormState({
      model: updatedPreset.model,
      baseUrl: updatedPreset.baseUrl ?? "",
      enabled: updatedPreset.enabled,
      isDefault: updatedPreset.isDefault
    });
  }

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, "Presets"),
    createElement(
      "ul",
      { className: "stack-list" },
      ...presets.map((preset) =>
        createElement(
          "li",
          {
            key: preset.id,
            className: "session-card"
          },
          createElement(
            "div",
            null,
            createElement("div", null, preset.name),
            createElement(
              "div",
              { className: "workspace-meta" },
              createElement("span", null, preset.enabled ? "Enabled" : "Disabled"),
              preset.isDefault ? createElement("span", null, "Default") : null
            )
          ),
          createElement(
            "button",
            {
              className: "secondary-button",
              type: "button",
              onClick: () => beginEdit(preset),
              "aria-label": `Edit ${preset.name}`
            },
            "Edit"
          )
        )
      )
    ),
    editingPresetId
      ? createElement(
          "form",
          { className: "form-stack", onSubmit: savePreset },
          createElement(
            "label",
            { className: "field" },
            createElement("span", null, "Model"),
            createElement("input", {
              "aria-label": "Model",
              value: formState.model,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const value = event.currentTarget.value;
                setFormState((current) => ({
                  ...current,
                  model: value
                }));
              }
            })
          ),
          createElement(
            "label",
            { className: "field" },
            createElement("span", null, "Base URL"),
            createElement("input", {
              "aria-label": "Base URL",
              value: formState.baseUrl,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const value = event.currentTarget.value;
                setFormState((current) => ({
                  ...current,
                  baseUrl: value
                }));
              }
            })
          ),
          createElement(
            "label",
            { className: "field checkbox-field" },
            createElement("input", {
              type: "checkbox",
              "aria-label": "Enabled",
              checked: formState.enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const checked = event.currentTarget.checked;
                setFormState((current) => ({
                  ...current,
                  enabled: checked
                }));
              }
            }),
            createElement("span", null, "Enabled")
          ),
          createElement(
            "label",
            { className: "field checkbox-field" },
            createElement("input", {
              type: "checkbox",
              "aria-label": "Default preset",
              checked: formState.isDefault,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const checked = event.currentTarget.checked;
                setFormState((current) => ({
                  ...current,
                  isDefault: checked
                }));
              }
            }),
            createElement("span", null, "Default preset")
          ),
          createElement(
            "button",
            {
              className: "primary-button",
              type: "submit"
            },
            "Save preset"
          )
        )
      : null
  );
}
