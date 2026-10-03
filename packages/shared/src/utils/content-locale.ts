import {
  canonicalizeLocale,
  localesShareLanguageAndScript,
} from "./locale-registry.js";

/** Key of a world record's metadata that lists the locales it has content for. */
export const WORLD_EDITIONS_KEY = "supportedLocales";

/** What a world record says about its language editions. */
export interface WorldEditions {
  /** The locale the world is written in. */
  readonly locale?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** The locales a world has content for: its declared editions, or its own language. */
export function worldEditionLocales(
  world: WorldEditions | undefined,
): readonly string[] {
  const declared = world?.metadata?.[WORLD_EDITIONS_KEY];
  const editions = Array.isArray(declared)
    ? declared.filter((item): item is string => typeof item === "string")
    : [];
  return editions.length > 0 ? editions : world?.locale ? [world.locale] : [];
}

/**
 * The content locale of a session of `world` for a player who asks for
 * `requested`.
 *
 * A session's content locale must be an edition the world has. A world
 * written in Chinese only, played with English as the content locale, puts
 * Chinese lore beside English instructions and asks for English output: the
 * model translates the world while it plays, and small models fail there
 * first. So when the world has no edition in the requested language, the
 * session is in the world's own language. The player's UI stays as it is.
 *
 * `changed` tells the caller that the player did not get the language asked
 * for, so that the client can say so.
 */
export function sessionContentLocale(
  world: WorldEditions | undefined,
  requested: string,
): { readonly locale: string; readonly changed: boolean } {
  const editions = worldEditionLocales(world);
  if (editions.length === 0) return { locale: requested, changed: false };
  const wanted = canonicalizeLocale(requested) ?? requested;
  const edition =
    editions.find((item) => canonicalizeLocale(item) === wanted) ??
    editions.find((item) => localesShareLanguageAndScript(item, wanted));
  if (edition) return { locale: edition, changed: false };
  return { locale: world?.locale ?? editions[0]!, changed: true };
}
