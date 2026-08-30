import fixtureDraftJson from "./fixture/world-import-draft-v0.json";
import { parseWorldImportDraft, type WorldImportDraft } from "./types.js";

/**
 * Draft intake seam for the review UI. Today it serves the frozen v0
 * fixture (no dependency on Dev B's extraction branch); tomorrow the real
 * pipeline hands its result over through the same async contract.
 */

const FIXTURE_LOAD_DELAY_MS = 120;

export async function fetchFixtureDraft(): Promise<WorldImportDraft> {
  await new Promise((resolve) => setTimeout(resolve, FIXTURE_LOAD_DELAY_MS));
  const parsed = parseWorldImportDraft(fixtureDraftJson as unknown);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  return parsed.draft;
}

export function buildExportPayload(draft: WorldImportDraft): string {
  return JSON.stringify(draft, null, 2);
}

export function exportFileName(draft: WorldImportDraft): string {
  return `world-import-draft-${draft.id}.json`;
}

/** Trigger a browser download of the approved draft. */
export function downloadWorldImportDraft(draft: WorldImportDraft): void {
  const blob = new Blob([buildExportPayload(draft)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exportFileName(draft);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
