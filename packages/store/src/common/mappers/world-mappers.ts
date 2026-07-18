/**
 * Backend-agnostic canonical row→record mappers for the world domain.
 */

import type { WorldRecord } from "../../types.js";
import type { JsonReader } from "./json-reader.js";

export interface WorldRow {
  id: string;
  name: string;
  description: string;
  lore: string | null;
  tags: unknown;
  locale: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string | null;
}

export function toWorldRecord(row: WorldRow, json: JsonReader): WorldRecord {
  const metadata = json.read(row.metadata) as
    Record<string, unknown> | undefined;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    lore: row.lore ?? undefined,
    tags: json.read(row.tags) as string[] | undefined,
    locale: row.locale ?? undefined,
    metadata,
    dimensions: metadata?.dimensions as WorldRecord["dimensions"],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt ?? undefined,
  };
}
