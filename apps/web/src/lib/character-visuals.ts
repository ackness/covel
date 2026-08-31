import type { MediaRef } from "@covel/shared";
import { isMediaRef } from "./media-ref-utils.js";

export interface CharacterVisualRequest {
  readonly variantId?: string;
  readonly outfit?: string;
  readonly expression?: string;
  readonly pose?: string;
}

export interface CharacterVisualFraming {
  readonly scale?: number;
  readonly offsetX?: number;
  readonly offsetY?: number;
}

export interface CharacterVisualVariant {
  readonly id?: string;
  readonly outfit?: string;
  readonly expression?: string;
  readonly pose?: string;
  readonly sprite?: unknown;
  readonly stage?: CharacterVisualFraming;
}

export interface CharacterVisualCatalog {
  readonly defaultVariant?: string;
  readonly variants?: readonly CharacterVisualVariant[];
}

export interface PresenceRecord {
  readonly characterId?: string;
  readonly displayName?: string;
  readonly avatar?: unknown;
  readonly sprite?: unknown;
  readonly visuals?: CharacterVisualCatalog;
}

export interface ResolvedCharacterVisual {
  readonly ref: MediaRef;
  readonly variantId?: string;
  readonly stage?: CharacterVisualFraming;
}

const DEFAULT_OUTFIT = "default";
const DEFAULT_EXPRESSION = "neutral";
const DEFAULT_POSE = "default";

function usableVariants(
  presence: PresenceRecord | undefined,
): ReadonlyArray<CharacterVisualVariant & { readonly sprite: MediaRef }> {
  const variants = Array.isArray(presence?.visuals?.variants)
    ? presence.visuals.variants
    : [];
  return variants.filter(
    (
      variant,
    ): variant is CharacterVisualVariant & { readonly sprite: MediaRef } =>
      typeof variant?.id === "string" && isMediaRef(variant.sprite),
  );
}

function selection(variant: CharacterVisualVariant): ResolvedCharacterVisual {
  return {
    ref: variant.sprite as MediaRef,
    ...(variant.id ? { variantId: variant.id } : {}),
    ...(variant.stage ? { stage: variant.stage } : {}),
  };
}

/**
 * Resolve a requested character visual with a deterministic Galgame-style
 * fallback chain. Legacy `sprite` / `avatar` records stay valid indefinitely.
 */
export function resolveCharacterVisual(
  presence: PresenceRecord | undefined,
  request?: CharacterVisualRequest,
): ResolvedCharacterVisual | null {
  const variants = usableVariants(presence);
  const defaultVariant = presence?.visuals?.defaultVariant
    ? variants.find(
        (variant) => variant.id === presence.visuals?.defaultVariant,
      )
    : undefined;
  const hasRequest = Boolean(
    request?.variantId ||
    request?.outfit ||
    request?.expression ||
    request?.pose,
  );

  if (!hasRequest) {
    if (defaultVariant) return selection(defaultVariant);
    if (variants[0]) return selection(variants[0]);
    if (isMediaRef(presence?.sprite)) return { ref: presence.sprite };
    if (isMediaRef(presence?.avatar)) return { ref: presence.avatar };
    return null;
  }

  if (request?.variantId) {
    const exactId = variants.find(
      (variant) => variant.id === request.variantId,
    );
    if (exactId) return selection(exactId);
  }

  const normalized = (variant: CharacterVisualVariant) => ({
    outfit: variant.outfit ?? DEFAULT_OUTFIT,
    expression: variant.expression ?? DEFAULT_EXPRESSION,
    pose: variant.pose ?? DEFAULT_POSE,
  });
  const catalogDefault = defaultVariant
    ? normalized(defaultVariant)
    : {
        outfit: DEFAULT_OUTFIT,
        expression: DEFAULT_EXPRESSION,
        pose: DEFAULT_POSE,
      };
  const outfit = request?.outfit ?? catalogDefault.outfit;
  const expression = request?.expression ?? DEFAULT_EXPRESSION;
  const pose = request?.pose ?? catalogDefault.pose;
  const matching = (
    wantedOutfit: string,
    wantedExpression: string,
    wantedPose: string,
  ) =>
    variants.find((variant) => {
      const value = normalized(variant);
      return (
        value.outfit === wantedOutfit &&
        value.expression === wantedExpression &&
        value.pose === wantedPose
      );
    });

  const resolved =
    matching(outfit, expression, pose) ??
    matching(outfit, expression, DEFAULT_POSE) ??
    matching(outfit, DEFAULT_EXPRESSION, DEFAULT_POSE) ??
    defaultVariant ??
    variants[0];
  if (resolved) return selection(resolved);
  if (isMediaRef(presence?.sprite)) return { ref: presence.sprite };
  if (isMediaRef(presence?.avatar)) return { ref: presence.avatar };
  return null;
}

/** All image refs a presence catalog may need, deduplicated by content id. */
export function collectCharacterVisualRefs(
  presence: PresenceRecord | undefined,
): MediaRef[] {
  const refs: MediaRef[] = [];
  const seen = new Set<string>();
  const add = (value: unknown) => {
    if (!isMediaRef(value) || seen.has(value.id)) return;
    seen.add(value.id);
    refs.push(value);
  };
  add(presence?.sprite);
  add(presence?.avatar);
  for (const variant of usableVariants(presence)) add(variant.sprite);
  return refs;
}

/** Replace the catalog's effective default while preserving every named
 * outfit/expression/pose variant. Used by the portrait gallery's legacy
 * "Replace" action so one upload does not accidentally erase the catalog. */
export function replaceDefaultCharacterVisual(
  presence: PresenceRecord | undefined,
  ref: MediaRef,
): CharacterVisualCatalog {
  const variants = Array.isArray(presence?.visuals?.variants)
    ? [...presence.visuals.variants]
    : [];
  const declaredDefault = presence?.visuals?.defaultVariant;
  const defaultId =
    (declaredDefault &&
    variants.some((variant) => variant.id === declaredDefault)
      ? declaredDefault
      : variants.find((variant) => typeof variant.id === "string")?.id) ??
    "default";
  const found = variants.some((variant) => variant.id === defaultId);
  const nextVariants = found
    ? variants.map((variant) =>
        variant.id === defaultId ? { ...variant, sprite: ref } : variant,
      )
    : [
        ...variants,
        {
          id: defaultId,
          outfit: DEFAULT_OUTFIT,
          expression: DEFAULT_EXPRESSION,
          pose: DEFAULT_POSE,
          sprite: ref,
        },
      ];
  return { defaultVariant: defaultId, variants: nextVariants };
}
