import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { StreamMessage } from "@/stores/session-store.js";

const INFO_LEVELS = new Set([undefined, "info", "success"]);

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Read-only plugin cards (codex discoveries, achievements, status changes)
 * that accompany a turn. Interactive blocks, images, suggestions, and
 * warnings are never folded away.
 */
export function isTurnUpdateMessage(message: StreamMessage): boolean {
  if (message.role !== "assistant" || message.kind !== "plugin") return false;
  const block = record(message.block);
  if (!block) return false;
  if (block.type === "ui.render" || block.type === "ui-spec") return true;
  if (block.type === "notification")
    return INFO_LEVELS.has(record(block.data)?.level as string | undefined);
  return false;
}

/** A short public label for an update card, when the plugin provides one. */
export function turnUpdateTitle(message: StreamMessage): string | undefined {
  const block = record(message.block);
  const data = record(block?.data);
  const candidates: unknown[] = [];
  for (const part of Array.isArray(data?.parts) ? data.parts : []) {
    const content = record(record(part)?.content);
    candidates.push(
      record(content?.meta)?.title,
      record(record(content?.spec)?.props)?.title,
      content?.title,
    );
  }
  candidates.push(
    record(block?.meta)?.title,
    record(record(data?.spec)?.props)?.title,
    data?.title,
  );
  const title = candidates.find(
    (value): value is string => typeof value === "string" && !!value.trim(),
  );
  return title?.trim();
}

const PREVIEW_TITLES = 3;

export function TurnUpdates({
  messages,
  defaultOpen,
  children,
}: {
  readonly messages: readonly StreamMessage[];
  readonly defaultOpen: boolean;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(defaultOpen);
  const titles = [
    ...new Set(messages.map(turnUpdateTitle).filter(Boolean)),
  ] as string[];
  const preview = titles.slice(0, PREVIEW_TITLES).join(" · ");
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      className="ui-turn-updates group rounded border border-border/50 px-3 py-2 text-xs text-muted-foreground"
      data-testid="turn-updates"
    >
      <summary className="cursor-pointer select-none">
        <span className="font-medium text-foreground/80">
          {t("session.turnUpdates", { count: messages.length })}
        </span>
        {preview && (
          <span className="ml-2">
            {preview}
            {titles.length > PREVIEW_TITLES && " …"}
          </span>
        )}
      </summary>
      {open && <div className="mt-3 space-y-3">{children}</div>}
    </details>
  );
}
