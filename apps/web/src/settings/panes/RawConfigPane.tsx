import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { RotateCw, Save, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { ApiError } from "@/services/api/request.js";
import {
  listRawConfigFiles,
  readRawConfigFile,
  saveRawConfigFile,
  type RawConfigFileInfo,
} from "@/services/api/raw-config.js";
import { useSession } from "@/stores/session-store.js";
import { settingLabels } from "../store.js";
import { useSettingsStore } from "../use-settings.js";

/** The settings of this device, which the SettingsStore owns. */
const SETTINGS = "settings";

interface Loaded {
  /** The text as the source holds it. */
  readonly text: string;
  /** For a file: sent back with the save. */
  readonly digest?: string;
  /** For a file that does not exist yet: the text is a starting point. */
  readonly missing?: boolean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * The raw configuration as text: the settings of this device as JSON, and the
 * files the server offers (`llm.toml`, and `config.toml` under the desktop
 * shell). Each save is checked first, and what was there before is kept.
 */
export function RawConfigPane() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const { boot } = useSession();
  const [files, setFiles] = useState<readonly RawConfigFileInfo[]>([]);
  const [backups, setBackups] = useState<readonly string[]>([]);
  const [source, setSource] = useState(SETTINGS);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const loadRequest = useRef(0);
  useEffect(
    () => () => {
      loadRequest.current += 1;
    },
    [],
  );
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const file = files.find((item) => item.name === source);
  const dirty = loaded !== null && draft !== loaded.text;

  const refreshBackups = useCallback(() => {
    store
      .listBackups()
      .then(setBackups)
      .catch(() => undefined);
  }, [store]);

  useEffect(() => {
    let alive = true;
    void listRawConfigFiles().then((list) => {
      if (alive) setFiles(list);
    });
    refreshBackups();
    return () => {
      alive = false;
    };
  }, [refreshBackups]);

  const load = useCallback(
    async (name: string) => {
      const request = ++loadRequest.current;
      setBusy(true);
      setLoaded(null);
      setDraft("");
      setError(null);
      try {
        const next: Loaded =
          name === SETTINGS
            ? {
                text: JSON.stringify((await store.export()).entries, null, 2),
              }
            : await readRawConfigFile(name).then((read) => ({
                text: read.content,
                digest: read.digest,
                missing: !read.exists,
              }));
        if (request !== loadRequest.current) return;
        setLoaded(next);
        setDraft(next.text);
      } catch (err) {
        if (request !== loadRequest.current) return;
        setLoaded(null);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (request === loadRequest.current) setBusy(false);
      }
    },
    [store],
  );

  useEffect(() => {
    setNote(null);
    void load(source);
  }, [source, load]);

  /** Replace the displayed snapshot in one write, rejecting concurrent edits. */
  async function saveSettings(): Promise<string | null> {
    let next: unknown;
    try {
      next = JSON.parse(draft);
    } catch (err) {
      throw new Error(
        t("settings.rawConfigInvalidJson", {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      throw new Error(t("settings.rawConfigNotObject"));
    }
    const entries = next as Record<string, unknown>;
    const registry = new Map(
      store.listEntries().map((entry) => [entry.key, entry]),
    );
    const secret = Object.keys(entries).filter((key) => {
      const entry = registry.get(key);
      return key.startsWith("keys.") || entry?.backend === "keys";
    });
    if (secret.length > 0) {
      throw new Error(
        t("settings.rawConfigSecretKeys", { keys: secret.join(", ") }),
      );
    }
    const refused = Object.entries(entries)
      .filter(([key, value]) => {
        const entry = registry.get(key);
        return !!entry && !entry.schema.safeParse(value).success;
      })
      .map(([key]) => key);
    if (refused.length > 0) {
      throw new Error(
        t("settings.rawConfigRefused", { keys: settingLabels(refused) }),
      );
    }
    const expected = JSON.parse(loaded!.text) as Record<string, unknown>;
    if (sameJson(entries, expected)) return null;
    const backup = await store.backup("edit");
    await store.replaceEntries(entries, expected);
    return backup;
  }

  async function save() {
    if (busy || !loaded) return;
    setSaving(true);
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      if (source === SETTINGS) {
        const backup = await saveSettings();
        setNote(
          backup
            ? t("settings.rawConfigSavedWithBackup", { backup })
            : t("settings.rawConfigSaved"),
        );
        refreshBackups();
        await load(SETTINGS);
        return;
      }
      const saved = await saveRawConfigFile(source, draft, loaded.digest ?? "");
      setLoaded({ text: saved.content, digest: saved.digest });
      setDraft(saved.content);
      setFiles(await listRawConfigFiles());
      if (saved.reload && !saved.reload.ok) {
        setError(
          t("settings.rawConfigReloadFailed", {
            error: saved.reload.error ?? "",
          }),
        );
      } else {
        setNote(
          saved.backup
            ? t("settings.rawConfigSavedWithBackup", { backup: saved.backup })
            : t("settings.rawConfigSaved"),
        );
      }
      // The model roles and their checks read the configuration from here.
      if (saved.reload) await boot();
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === "config_file_changed"
          ? t("settings.rawConfigChanged")
          : err instanceof ApiError
            ? (err.response?.error ?? err.message)
            : err instanceof Error
              ? err.message
              : String(err),
      );
    } finally {
      setSaving(false);
      setBusy(false);
    }
  }

  /** Put an earlier copy of the settings in the editor; saving applies it. */
  async function loadBackup(name: string) {
    const request = ++loadRequest.current;
    setBusy(true);
    setError(null);
    try {
      const text = await store.readBackup(name).catch(() => null);
      if (request !== loadRequest.current) return;
      if (text === null) return setError(t("settings.backupUnreadable"));
      try {
        const parsed = JSON.parse(text) as { entries?: unknown };
        setDraft(
          JSON.stringify(
            parsed && typeof parsed === "object" && "entries" in parsed
              ? parsed.entries
              : parsed,
            null,
            2,
          ),
        );
      } catch {
        setDraft(text);
      }
      setNote(t("settings.rawConfigBackupLoaded", { name }));
    } finally {
      if (request === loadRequest.current) setBusy(false);
    }
  }

  const tabs = [
    { id: SETTINGS, label: t("settings.rawConfigSettingsTab") },
    ...files.map((item) => ({ id: item.name, label: item.name })),
  ];

  return (
    <div className="space-y-3">
      <div
        role="tablist"
        aria-label={t("settings.rawConfigNavLabel")}
        className="flex w-fit max-w-full flex-wrap overflow-hidden rounded-(--radius-control) border border-(--rule-color)"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={source === tab.id}
            disabled={saving}
            onClick={() => setSource(tab.id)}
            className={
              "px-3 py-1.5 font-mono text-xs transition-colors " +
              (source === tab.id
                ? "bg-[color-mix(in_oklab,var(--accent-primary)_14%,transparent)] font-medium text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {tab.label}
          </button>
        ))}
      </div>

      <p className="break-all text-xs leading-relaxed text-muted-foreground">
        {file
          ? t(
              file.applies === "reload"
                ? "settings.rawConfigFileHintReload"
                : "settings.rawConfigFileHintRestart",
              { path: file.path },
            )
          : t("settings.rawConfigSettingsHint")}
        {loaded?.missing ? ` ${t("settings.rawConfigMissing")}` : ""}
      </p>

      <textarea
        aria-label={tabs.find((tab) => tab.id === source)?.label}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        disabled={busy || loaded === null}
        spellCheck={false}
        wrap="off"
        className="block h-88 w-full resize-y rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) p-3 font-mono text-xs leading-relaxed outline-none focus:border-(--accent-primary) focus:ring-1 focus:ring-(--accent-primary)"
      />

      {error && (
        <p
          role="alert"
          className="whitespace-pre-wrap wrap-break-word text-xs text-destructive"
        >
          {error}
        </p>
      )}
      {note && !error && (
        <p role="status" className="text-xs text-(--accent-primary)">
          {note}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={save} disabled={busy || !dirty}>
          <Save className="mr-1 h-3 w-3" />
          {t("common.save")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !dirty}
          onClick={() => {
            setDraft(loaded?.text ?? "");
            setError(null);
            setNote(null);
          }}
        >
          <Undo2 className="mr-1 h-3 w-3" />
          {t("settings.rawConfigRevert")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => {
            setNote(null);
            void load(source);
          }}
        >
          <RotateCw className="mr-1 h-3 w-3" />
          {t("settings.rawConfigReload")}
        </Button>
        {source === SETTINGS && backups.length > 0 && (
          <select
            aria-label={t("settings.rawConfigLoadBackup")}
            value=""
            disabled={busy}
            onChange={(event) => {
              if (event.target.value) void loadBackup(event.target.value);
            }}
            className="max-w-full rounded-(--radius-control) border border-(--rule-color) bg-(--surface-page) px-2 py-1.5 text-xs outline-none focus:ring-1 focus:ring-(--accent-primary)"
          >
            <option value="">{t("settings.rawConfigLoadBackup")}</option>
            {backups.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>
    </div>
  );
}
