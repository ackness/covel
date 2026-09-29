import { mediaRefSchema } from "@covel/shared";
import type {
  AssetGeneratePayload,
  RuntimeResult,
  TurnResult,
} from "@covel/shared";

export interface ExpectAssetGeneratedOptions {
  /** Expected asset modality, for example `image`, `audio`, or a plugin-owned modality. */
  readonly modality?: string;
}

type AssertionSource = TurnResult | RuntimeResult | readonly RuntimeResult[];

interface AssetCandidate {
  readonly value: unknown;
  readonly path: string;
}

/**
 * Assert that a runtime result or turn result emitted an `asset.generate` payload.
 *
 * Reads explicit runtime effects from `RuntimeResult.effects.assetGenerations`.
 *
 * @returns The first matching asset payload.
 *
 * @example
 * ```typescript
 * const result = await harness.executeTurn('Draw a mountain');
 * const asset = expectAssetGenerated(result, { modality: 'image' });
 * expect(asset.ref.mime).toBe('image/png');
 * ```
 */
export function expectAssetGenerated(
  source: AssertionSource,
  expected: ExpectAssetGeneratedOptions | string = {},
): AssetGeneratePayload {
  const options =
    typeof expected === "string" ? { modality: expected } : expected;
  const candidates = collectAssetCandidates(source);

  if (candidates.length === 0) {
    throw new Error(
      "Expected asset.generate effect in effects.assetGenerations[]",
    );
  }

  const validAssets = candidates
    .map((candidate) => ({ candidate, parsed: parseAsset(candidate.value) }))
    .filter(
      (
        entry,
      ): entry is { candidate: AssetCandidate; parsed: AssetGeneratePayload } =>
        entry.parsed !== null,
    );

  if (validAssets.length === 0) {
    throw new Error(
      `Expected asset.generate payload with MediaRef shape; checked ${formatPaths(candidates)}`,
    );
  }

  if (options.modality === undefined) {
    return validAssets[0].parsed;
  }

  const matching = validAssets.find(
    (entry) => entry.parsed.modality === options.modality,
  );
  if (matching) {
    return matching.parsed;
  }

  const actual = validAssets.map((entry) => entry.parsed.modality).join(", ");
  throw new Error(
    `Expected asset.generate modality "${options.modality}", received ${actual}`,
  );
}

function collectAssetCandidates(source: AssertionSource): AssetCandidate[] {
  if (isRuntimeResultArray(source)) {
    return source.flatMap((result, index) =>
      collectFromRuntimeResult(result, `runtimeResults[${index}]`),
    );
  }

  if (isTurnResult(source)) {
    return source.runtimeResults.flatMap((result, index) =>
      collectFromRuntimeResult(result, `runtimeResults[${index}]`),
    );
  }

  return collectFromRuntimeResult(source, "runtimeResult");
}

function collectFromRuntimeResult(
  result: RuntimeResult,
  path: string,
): AssetCandidate[] {
  return collectArray(
    result.effects?.assetGenerations,
    `${path}.effects.assetGenerations`,
  );
}

function collectArray(value: unknown, path: string): AssetCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item, index) => ({
    value: item,
    path: `${path}[${index}]`,
  }));
}

function parseAsset(value: unknown): AssetGeneratePayload | null {
  if (!isRecord(value)) {
    return null;
  }

  if (typeof value.modality !== "string" || value.modality.length === 0) {
    return null;
  }

  const refResult = mediaRefSchema.safeParse(value.ref);
  if (!refResult.success) {
    return null;
  }

  if (value.meta !== undefined && !isRecord(value.meta)) {
    return null;
  }

  return {
    ref: refResult.data,
    modality: value.modality,
    ...(value.meta === undefined ? {} : { meta: value.meta }),
  };
}

function isRuntimeResultArray(
  value: unknown,
): value is readonly RuntimeResult[] {
  return Array.isArray(value);
}

function isTurnResult(value: unknown): value is TurnResult {
  return isRecord(value) && Array.isArray(value.runtimeResults);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function formatPaths(candidates: readonly AssetCandidate[]): string {
  return candidates.map((candidate) => candidate.path).join(", ");
}
