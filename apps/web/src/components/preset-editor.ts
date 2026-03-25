import React, { createElement, useEffect, useState } from "react";

import type { PresetMetadata } from "../../../../modules/model-gateway/src/index.js";
import { getStoredLocale, useI18n } from "../i18n.js";

type EditablePreset = PresetMetadata & {
  apiKey?: string;
};

export function PresetEditor(input: {
  runtimeBaseUrl: string;
}) {
  const { t } = useI18n();
  const [presets, setPresets] = useState<EditablePreset[]>([]);
  const [editingPresetId, setEditingPresetId] = useState<string | null>(null);
  const [formState, setFormState] = useState<{
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }>({
    model: "",
    enabled: true,
    isDefault: false
  });

  useEffect(() => {
    void loadPresets();
  }, []);

  async function loadPresets() {
    const response = await fetch(`${input.runtimeBaseUrl}/presets`, {
      headers: {
        "accept-language": getStoredLocale()
      }
    });
    const payload = await response.json() as EditablePreset[];
    setPresets(payload);
  }

  function beginEdit(preset: EditablePreset) {
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

    const response = await fetch(`${input.runtimeBaseUrl}/presets/${editingPresetId}`, {
      method: "PUT",
      headers: {
        "accept-language": getStoredLocale(),
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: formState.model,
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
      enabled: updatedPreset.enabled,
      isDefault: updatedPreset.isDefault
    });
  }

  return createElement(
    "section",
    { className: "panel-section" },
    createElement("div", { className: "eyebrow" }, t("preset.presets")),
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
          { className: "form-stack", onSubmit: savePreset },
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
              type: "submit"
            },
            t("preset.save")
          )
        )
      : null
  );
}
