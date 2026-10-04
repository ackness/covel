import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useSettingsStore } from "./use-settings.js";

/** A stored bundle as readable JSON; text that is not JSON shows as it is. */
function readable(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function download(name: string, text: string): void {
  const fileName = name.replace(/[^A-Za-z0-9._-]+/g, "-");
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName.endsWith(".json") ? fileName : `${fileName}.json`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * The copies the app kept when it could not use earlier settings. The notice
 * that names a copy says it can be viewed; this is where. Nothing shows while
 * there is no copy.
 */
export function SettingsBackups() {
  const { t } = useTranslation();
  const store = useSettingsStore();
  const [names, setNames] = useState<readonly string[]>([]);
  const [shown, setShown] = useState<{
    name: string;
    text: string | null;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    store
      .listBackups()
      .then((list) => {
        if (alive) setNames(list);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [store]);

  if (names.length === 0) return null;

  const read = (name: string) => store.readBackup(name).catch(() => null);

  return (
    <section className="space-y-2">
      <h3 className="text-[13px] font-medium leading-snug text-foreground">
        {t("settings.backupsHeader")}
      </h3>
      <p className="text-xs leading-relaxed text-muted-foreground">
        {t("settings.backupsDescription")}
      </p>
      <ul className="divide-y divide-(--rule-color) rounded-(--radius-control) border border-(--rule-color)">
        {names.map((name) => {
          const open = shown?.name === name;
          return (
            <li key={name} className="space-y-2 px-3 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="min-w-0 break-all font-mono text-xs">
                  {name}
                </span>
                <div className="flex shrink-0 items-center gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    aria-expanded={open}
                    onClick={async () => {
                      if (open) return setShown(null);
                      setShown({ name, text: await read(name) });
                    }}
                  >
                    {open ? (
                      <EyeOff className="mr-1 h-3 w-3" />
                    ) : (
                      <Eye className="mr-1 h-3 w-3" />
                    )}
                    {t(open ? "settings.backupHide" : "settings.backupView")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={async () => {
                      const text = await read(name);
                      if (text === null) setShown({ name, text });
                      else download(name, text);
                    }}
                  >
                    <Download className="mr-1 h-3 w-3" />
                    {t("settings.backupDownload")}
                  </Button>
                </div>
              </div>
              {open &&
                (shown.text === null ? (
                  <p role="alert" className="text-xs text-destructive">
                    {t("settings.backupUnreadable")}
                  </p>
                ) : (
                  <pre className="max-h-64 overflow-auto rounded-(--radius-control) border border-(--rule-color) bg-(--surface-inset) p-2 font-mono text-[11px] leading-relaxed">
                    {readable(shown.text)}
                  </pre>
                ))}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
