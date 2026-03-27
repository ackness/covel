import React, { createElement, useState } from "react";

import { useI18n } from "../i18n.js";

export interface PresetEditorPreset {
  id: string;
  name: string;
  provider: string;
  model: string;
  enabled: boolean;
  isDefault: boolean;
  scope: string;
  baseUrl?: string;
  fallbackPresetIds?: string[];
  apiKey?: string;
}

export function PresetEditor(input: {
  presets: PresetEditorPreset[];
  onSave(input: {
    presetId: string;
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }): Promise<void> | void;
}) {
  const { t } = useI18n();
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [formState, setFormState] = useState<{
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }>({
    model: "",
    enabled: true,
    isDefault: false
  });

  function beginEdit(preset: PresetEditorPreset) {
    setEditingPresetId(preset.id);
    setFormState({
      model: preset.model,
      enabled: preset.enabled,
      isDefault: preset.isDefault
    });
  }

  async function savePreset(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editingPresetId) {
      return;
    }

    setIsSaving(true);
    try {
      await input.onSave({
        presetId: editingPresetId,
        model: formState.model,
        enabled: formState.enabled,
        isDefault: formState.isDefault
      });
    } finally {
      setIsSaving(false);
    }
  }

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, t("preset.presets")),
    createElement(
      "ul",
      { className: "stack-list" },
      ...input.presets.map((preset) =>
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
              createElement("span", null, preset.enabled ? t("preset.enabled") : t("preset.disabled")),
              preset.isDefault ? createElement("span", null, t("preset.default")) : null
            )
          ),
          createElement(
            "button",
            {
              className: "secondary-button",
              type: "button",
              onClick: () => beginEdit(preset),
              "aria-label": t("preset.editAria", {
                name: preset.name
              })
            },
            t("preset.edit")
          )
        )
      )
    ),
    editingPresetId
      ? createElement(
          "form",
          { className: "form-stack", onSubmit: (event: React.FormEvent<HTMLFormElement>) => void savePreset(event) },
          createElement(
            "label",
            { className: "field" },
            createElement("span", null, t("preset.model")),
            createElement("input", {
              "aria-label": t("preset.model"),
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
            { className: "field checkbox-field" },
            createElement("input", {
              type: "checkbox",
              "aria-label": t("preset.enabled"),
              checked: formState.enabled,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const checked = event.currentTarget.checked;
                setFormState((current) => ({
                  ...current,
                  enabled: checked
                }));
              }
            }),
            createElement("span", null, t("preset.enabled"))
          ),
          createElement(
            "label",
            { className: "field checkbox-field" },
            createElement("input", {
              type: "checkbox",
              "aria-label": t("preset.defaultPreset"),
              checked: formState.isDefault,
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
                const checked = event.currentTarget.checked;
                setFormState((current) => ({
                  ...current,
                  isDefault: checked
                }));
              }
            }),
            createElement("span", null, t("preset.defaultPreset"))
          ),
          createElement(
            "button",
            {
              className: "primary-button",
              type: "submit",
              disabled: isSaving
            },
            t("preset.save")
          )
        )
      : null
  );
}
