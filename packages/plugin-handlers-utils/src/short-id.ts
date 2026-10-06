/**
 * Allocate entity references that read as words. Models read these IDs in
 * injected data and sometimes write them back, so every character costs
 * tokens and a long random part invites copy mistakes. IDs stay within
 * `[a-z0-9-]`, the charset blueprint, rule, and portable world-data IDs
 * require, so a label without ASCII letters or digits gets eight hex digits
 * instead of words: a digest of the label in `wordId`, a random part in
 * `shortId`.
 *
 * No process-local counter: IDs must survive restarts and independent workers.
 * Existing IDs remain valid; callers must retain returned IDs when updating.
 */

import type { PluginRandom } from "./function-runtime.js";

const MAX_SLUG_LENGTH = 32;

/** Eight random hex digits, from the host's `ctx.random` when given. */
const randomPart = (random?: PluginRandom) =>
  random
    ? random
        .int(0, 2 ** 32)
        .toString(16)
        .padStart(8, "0")
    : crypto.randomUUID().replaceAll("-", "").slice(0, 8);

/**
 * Eight hex digits of the label (FNV-1a over its UTF-16 units). The same
 * label gives the same part in every session, so a model that wrote the ID in
 * one run of a session finds it in the next run.
 */
function labelPart(label: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < label.length; index += 1) {
    hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** The label's ASCII letters and digits, lowercased and hyphenated. */
export function wordSlug(label: string): string {
  return (label.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .join("-")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-$/, "");
}

/**
 * A word ID: the prefix and the label's words (`npc-lin-yao`), with `-2`,
 * `-3`… when that ID is taken. Use it when the caller can see every existing
 * ID in the namespace; otherwise use `shortId`. A label with no ASCII words
 * gets the 8-hex digest of the label (`char-3fa9c1d2`), numbered the same way
 * when taken.
 */
export function wordId(
  prefix: string,
  label: string,
  taken: ReadonlySet<string>,
): string {
  const base = `${prefix}-${wordSlug(label) || labelPart(label.trim())}`;
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Allocate a new ID without reading the namespace: the label's words plus an
 * 8-hex random part, so repeated labels and lossy slugs stay distinct.
 * The session argument is retained for source compatibility, not uniqueness.
 * Names are display text, not identity; deduplicate against stored entities.
 * Pass the context's `random`: the random part then repeats in a test server
 * started with a seed, as every other draw of the plugin does.
 */
export function shortId(
  prefix: string,
  label: string,
  _sessionId: string,
  random?: PluginRandom,
): string {
  return [prefix, wordSlug(label), randomPart(random)]
    .filter(Boolean)
    .join("-");
}

/** Allocate independent IDs; slug truncation and duplicate labels cannot alias. */
export function shortIdBatch(
  prefix: string,
  labels: readonly string[],
  sessionId: string,
  random?: PluginRandom,
): string[] {
  return labels.map((label) => shortId(prefix, label, sessionId, random));
}
