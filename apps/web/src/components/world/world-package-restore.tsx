import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button.js";
import { requestConfirm } from "@/lib/confirm-channel.js";
import * as api from "@/services/api.js";
import type { WorldRecord } from "@/services/api.js";
import { getStorageMode } from "@/services/data-service.js";

/**
 * A server world can return to its package after an app edit or apply changed
 * package files. Browser-local copies have no restore action on the server.
 */
export function canRestoreWorldPackage(world: WorldRecord): boolean {
  return (
    getStorageMode() !== "local" &&
    (world.metadata?.packageModified === true || world.updateAvailable === true)
  );
}

interface WorldPackageRestoreProps {
  world: WorldRecord;
  onRestored: (world: WorldRecord) => void;
}

/** Say that the edits stay, and offer the package version back. */
export function WorldPackageRestore({
  world,
  onRestored,
}: WorldPackageRestoreProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function restore() {
    const confirmed = await requestConfirm({
      title: t("world.restorePackageTitle"),
      message: t("world.restorePackageConfirm"),
      confirmLabel: t("world.restorePackageAction"),
      cancelLabel: t("common.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      onRestored(await api.restoreWorldPackage(world.id));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("world.restorePackageFailed"),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      role="note"
      className="max-w-3xl space-y-2 rounded border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
    >
      <p>
        {t(
          world.updateAvailable
            ? "world.packageUpdateHint"
            : "world.packageEditedHint",
        )}
      </p>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void restore()}
      >
        {t("world.restorePackageAction")}
      </Button>
      {error && (
        <p role="alert" className="text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
