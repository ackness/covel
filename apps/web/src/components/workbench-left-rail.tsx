import React from "react";

import { useI18n } from "../i18n.js";
import type { PresetSummary, WorldRecord } from "../types.js";
import { PresetEditor } from "./preset-editor.js";

interface WorkbenchLeftRailProps {
  presets: PresetSummary[];
  selectedWorldId: string | null;
  worldDescription: string;
  worldName: string;
  worlds: WorldRecord[];
  onPresetSave(input: {
    presetId: string;
    model: string;
    enabled: boolean;
    isDefault: boolean;
  }): Promise<void> | void;
  onCreateStarterWorld(): void;
  onCreateWorld(event: React.FormEvent<HTMLFormElement>): void;
  onSelectWorld(worldId: string): void;
  onWorldDescriptionChange(nextValue: string): void;
  onWorldNameChange(nextValue: string): void;
}

export function WorkbenchLeftRail(props: WorkbenchLeftRailProps) {
  const { t } = useI18n();

  return (
    <div className="workbench-left-rail">
      <section className="panel-section rail-section">
        <div className="eyebrow">{t("app.worldNavigator")}</div>
        <p className="field-hint">{t("app.worldNavigatorSummary")}</p>
        <div className="section-heading">
          <span className="section-title">{t("app.worlds")}</span>
          <span className="workspace-meta section-count">{props.worlds.length}</span>
        </div>
        <ul className="stack-list">
          {props.worlds.length > 0 ? props.worlds.map((world) => (
            <li key={world.id}>
              <button
                type="button"
                className={world.id === props.selectedWorldId ? "list-button active" : "list-button"}
                onClick={() => props.onSelectWorld(world.id)}
              >
                <span>{world.name}</span>
              </button>
            </li>
          )) : (
            <li className="empty-copy">{t("app.emptyWorldTitle")}</li>
          )}
        </ul>
      </section>

      <form className="panel-section form-stack rail-section" onSubmit={props.onCreateWorld}>
        <div className="section-heading">
          <span className="section-title">{t("app.createWorld")}</span>
        </div>
        <label className="field">
          <span>{t("app.worldName")}</span>
          <input
            aria-label={t("app.worldName")}
            value={props.worldName}
            onChange={(event) => props.onWorldNameChange(event.currentTarget.value)}
          />
        </label>
        <label className="field">
          <span>{t("app.worldDescription")}</span>
          <textarea
            aria-label={t("app.worldDescription")}
            value={props.worldDescription}
            onChange={(event) => props.onWorldDescriptionChange(event.currentTarget.value)}
          />
        </label>
        <div className="button-row">
          <button type="submit" className="primary-button">{t("app.createWorld")}</button>
          <button type="button" className="secondary-button" onClick={() => props.onCreateStarterWorld()}>
            {t("app.createStarterWorld")}
          </button>
        </div>
      </form>

      <PresetEditor
        presets={props.presets}
        onSave={props.onPresetSave}
      />
    </div>
  );
}
