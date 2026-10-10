import type {
  AssetGeneratePayload,
  MediaRef,
  Proposal,
  ProposalSource,
} from "../types/index.js";
import { mediaRefSchema } from "../types/index.js";

export interface AssetGenerateView {
  readonly id: string;
  readonly type: "asset.generate";
  readonly sessionId: string;
  readonly turnId: string;
  readonly source: ProposalSource;
  readonly ref: MediaRef;
  readonly modality: string;
  readonly meta?: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
}

/** A picture the player was shown, as the model is told about it. */
export interface ShownPicture {
  readonly ref: MediaRef;
  /** What the picture depicts; absent when its producer said nothing. */
  readonly caption?: string;
}

export function isAssetGeneratePayload(
  value: unknown,
): value is AssetGeneratePayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  if (typeof payload.modality !== "string" || payload.modality.length === 0)
    return false;
  if (!mediaRefSchema.safeParse(payload.ref).success) return false;
  if (payload.meta !== undefined && !isPlainRecord(payload.meta)) return false;
  return true;
}

export function isAssetGenerateView(
  value: unknown,
): value is AssetGenerateView {
  if (!value || typeof value !== "object") return false;
  const view = value as Record<string, unknown>;
  const source = view.source as Record<string, unknown> | undefined;
  if (view.type !== "asset.generate") return false;
  if (typeof view.id !== "string" || view.id.length === 0) return false;
  if (typeof view.sessionId !== "string" || view.sessionId.length === 0)
    return false;
  if (typeof view.turnId !== "string" || view.turnId.length === 0) return false;
  if (
    !source ||
    typeof source.pluginId !== "string" ||
    typeof source.runtimeId !== "string"
  )
    return false;
  if (typeof view.modality !== "string" || view.modality.length === 0)
    return false;
  if (!mediaRefSchema.safeParse(view.ref).success) return false;
  if (view.meta !== undefined && !isPlainRecord(view.meta)) return false;
  if (typeof view.createdAt !== "string" || view.createdAt.length === 0)
    return false;
  return true;
}

export function assetGenerateToView(proposal: Proposal): AssetGenerateView {
  if (proposal.type !== "asset.generate") {
    throw new Error(
      `assetGenerateToView expected asset.generate, received ${proposal.type}`,
    );
  }
  if (!isAssetGeneratePayload(proposal.payload)) {
    throw new Error(
      "assetGenerateToView expected payload { ref: MediaRef, modality: string, meta?: object }",
    );
  }

  return {
    id: proposal.id,
    type: "asset.generate",
    sessionId: proposal.sessionId,
    turnId: proposal.turnId,
    source: proposal.source,
    ref: proposal.payload.ref,
    modality: proposal.payload.modality,
    ...(proposal.payload.meta ? { meta: proposal.payload.meta } : {}),
    createdAt: proposal.timestamp,
  };
}

/** A caption longer than this is cut: an image prompt can run to pages. */
const PICTURE_CAPTION_MAX_CHARS = 600;

/**
 * The picture an asset view shows, or `null` for another modality. The
 * caption is the producer's `meta.caption`, else the `meta.prompt` the
 * picture was generated from.
 */
export function pictureOf(view: AssetGenerateView): ShownPicture | null {
  if (view.modality !== "image" && !view.ref.mime.startsWith("image/"))
    return null;
  const text = [view.meta?.caption, view.meta?.prompt].find(
    (value): value is string =>
      typeof value === "string" && value.trim().length > 0,
  );
  const caption = text?.replace(/\s+/g, " ").trim();
  return {
    ref: view.ref,
    ...(caption
      ? {
          caption:
            caption.length > PICTURE_CAPTION_MAX_CHARS
              ? `${caption.slice(0, PICTURE_CAPTION_MAX_CHARS)}…`
              : caption,
        }
      : {}),
  };
}

/**
 * Pictures among the blocks a conversation row showed the player (the `ui`
 * of a turn message). Anything that is not an image asset block is skipped.
 */
export function picturesShown(blocks: unknown): readonly ShownPicture[] {
  if (!Array.isArray(blocks)) return [];
  return blocks.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const data = (block as { readonly data?: unknown }).data;
    const picture = isAssetGenerateView(data) ? pictureOf(data) : null;
    return picture ? [picture] : [];
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
