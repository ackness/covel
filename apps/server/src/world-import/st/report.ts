import type { ST_IMPORT_CODES, StImportItem } from "@covel/shared";

export type StImportCode = (typeof ST_IMPORT_CODES)[number];
export class StImportError extends Error {
  readonly details: { code: StImportCode };
  constructor(
    readonly code: StImportCode,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "StImportError";
    this.details = { code };
  }
}

/** Aggregate repeated losses by source and field without exposing dropped values. */
export class ImportReporter {
  readonly items: StImportItem[] = [];
  private readonly byKey = new Map<string, StImportItem>();
  add(
    level: StImportItem["level"],
    code: StImportCode,
    source: string,
    message: string,
    field?: string,
    count = 1,
  ) {
    const key = JSON.stringify([code, source, field ?? null]);
    const existing = this.byKey.get(key);
    if (existing) {
      existing.count = (existing.count ?? 0) + count;
    } else {
      const item = {
        level,
        code,
        source,
        message,
        ...(field ? { field } : {}),
        count,
      };
      this.items.push(item);
      this.byKey.set(key, item);
    }
  }
}

export function safeFieldName(name: string): string {
  return /^[A-Za-z0-9_.-]{1,40}$/.test(name) ? name : "<invalid>";
}
