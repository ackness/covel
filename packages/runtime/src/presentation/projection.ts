import { createHash } from "node:crypto";
import {
  currentCharacterOf,
  primarySeat,
  resolveCharacter,
  presentationSnapshotSchema,
  presentationStorySchema,
  type PresentationSnapshot,
  type PresentationStory,
  type RuntimeManifest,
  type RuntimeResult,
  type TurnDigest,
} from "@covel/shared";
import type { DataStore } from "@covel/store";
import { deepFreeze } from "../hooks/hook-settings.js";
import { mergePluginDataRows } from "../function-runtime/execution-write-buffer.js";
import type { UpstreamPluginDataWrite } from "../function-runtime/upstream-plugin-data.js";
import { presentationLimits, presentationNamespaces } from "./policy.js";

export class PresentationUnavailable extends Error {
  override readonly name = "PresentationUnavailable";
  constructor() {
    super("Presentation source is unavailable");
  }
}

/** Copy each public field explicitly; never spread StoryOutput or a result. */
export function projectPresentationStory(
  value: unknown,
): PresentationStory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!Array.isArray(raw.segments)) return undefined;
  const cues =
    raw.cues && typeof raw.cues === "object"
      ? (raw.cues as Record<string, unknown>)
      : undefined;
  const parsed = presentationStorySchema.safeParse({
    segments: raw.segments.map((rawSegment: unknown) => {
      if (!rawSegment || typeof rawSegment !== "object") return null;
      const segment = rawSegment as Record<string, unknown>;
      return {
        kind: segment.kind,
        text: segment.text,
        ...(segment.speaker !== undefined ? { speaker: segment.speaker } : {}),
      };
    }),
    ...(cues
      ? {
          cues: {
            ...(cues.scene !== undefined ? { scene: cues.scene } : {}),
            ...(cues.mood !== undefined ? { mood: cues.mood } : {}),
            ...(cues.present !== undefined ? { present: cues.present } : {}),
          },
        }
      : {}),
  });
  return parsed.success ? deepFreeze(parsed.data) : undefined;
}

export function publicStoryCandidate(
  runtimes: readonly RuntimeManifest[],
  results: readonly RuntimeResult[],
) {
  const providers = runtimes.filter(
    (runtime) =>
      runtime.outputKind === "story" &&
      !runtime.concealed &&
      runtime.outputContract === "narrative-engine@2",
  );
  if (providers.length !== 1) return undefined;
  const result = results.find(
    (result) =>
      result.runtimeId === providers[0]!.name &&
      result.pluginId === providers[0]!.pluginId &&
      result.status === "success",
  );
  return result ? projectPresentationStory(result.output) : undefined;
}

type ProjectionStore = Pick<
  DataStore,
  "getSession" | "listCharacters" | "listPluginData"
>;

/** Public equality scope; the private incarnation nonce never leaves storage. */
export async function presentationIncarnation(
  store: Pick<DataStore, "getSession">,
  sessionId: string,
) {
  const session = await store.getSession(sessionId);
  const nonce = session?.metadata?.sessionIncarnationNonce;
  return typeof nonce === "string" && nonce.length
    ? createHash("sha256").update(`incarnation:${nonce}`).digest("hex")
    : undefined;
}

/** Materialize a bounded source once, before plugin code can receive it. */
export async function takePresentationSnapshot(options: {
  readonly store?: ProjectionStore;
  readonly manifest: RuntimeManifest;
  readonly sessionId: string;
  readonly sourceTurnId: string;
  readonly sourceExecutionId: string;
  readonly incarnation?: string;
  readonly locale?: string;
  readonly story?: PresentationStory;
  readonly upstream?: readonly UpstreamPluginDataWrite[];
}): Promise<PresentationSnapshot> {
  const { store, manifest, sessionId, story } = options;
  const { reads, writes } = presentationNamespaces(manifest);
  const data: PresentationSnapshot["data"] = {};
  const baselines: PresentationSnapshot["baselines"] = {};
  for (const namespace of new Set([...reads, ...writes])) {
    const rows =
      (await store?.listPluginData(sessionId, manifest.pluginId, namespace)) ??
      [];
    const visible = mergePluginDataRows(
      rows,
      [],
      sessionId,
      manifest.pluginId,
      namespace,
      options.upstream,
    );
    if (rows.length > 50 || visible.length > 50)
      throw new PresentationUnavailable();
    if (reads.has(namespace))
      data[namespace] = visible.map(({ key, value }) => ({
        key,
        value: value as PresentationSnapshot["data"][string][number]["value"],
      }));
    if (writes.has(namespace))
      baselines[namespace] = rows.map(({ key, value, updatedAt }) => ({
        key,
        value: value as PresentationSnapshot["data"][string][number]["value"],
        updatedAt,
      }));
  }
  const sourceCharacters = (await store?.listCharacters(sessionId)) ?? [];
  const identities = sourceCharacters.map(({ id, name, aliases }) => ({
    id,
    name,
    ...(aliases ? { aliases: [...aliases] } : {}),
  }));
  const names = new Set([
    ...(story?.cues?.present ?? []),
    ...(story?.segments.flatMap((segment) =>
      segment.speaker ? [segment.speaker] : [],
    ) ?? []),
  ]);
  const wanted = new Set<string>();
  for (const name of names) {
    const match = resolveCharacter(identities, name);
    if (match.status === "found") wanted.add(match.character.id);
    // Keep every exact candidate, never the resolver's similar-name hints.
    else if (match.status === "ambiguous")
      for (const identity of match.candidates) wanted.add(identity.id);
  }
  const characters = identities.filter(({ id }) => wanted.has(id));
  const session = await store?.getSession(sessionId);
  const seats = session?.seats ?? [];
  const viewpoint = currentCharacterOf(
    primarySeat(seats),
    sourceCharacters,
    seats,
  );
  const incarnation = store
    ? await presentationIncarnation(store, sessionId)
    : options.incarnation;
  const parsed = presentationSnapshotSchema.safeParse({
    version: 1,
    committed: false,
    sourceTurnId: options.sourceTurnId,
    sourceExecutionId: options.sourceExecutionId,
    pluginId: manifest.pluginId,
    runtimeId: manifest.name,
    ...(options.locale ? { locale: options.locale } : {}),
    ...(incarnation ? { incarnation } : {}),
    limits: presentationLimits(manifest),
    ...(story ? { story } : {}),
    characters,
    ...(viewpoint ? { viewpointCharacterId: viewpoint.id } : {}),
    data,
    baselines,
  });
  if (!parsed.success) throw new PresentationUnavailable();
  return deepFreeze(parsed.data);
}

/** Ordinary-job fields stay present, but contain no raw source content. */
export function emptyPresentationDigest(
  turnId: string,
  locale?: string,
): TurnDigest {
  return {
    turnId,
    playerMessage: "",
    actions: [],
    lastPlayerInput: null,
    narrativeText: "",
    toolCallSummaries: [],
    runtimeResults: [],
    ...(locale ? { locale } : {}),
  };
}
