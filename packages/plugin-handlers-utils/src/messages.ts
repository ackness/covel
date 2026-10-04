/**
 * Text that plugin code writes: a message to the player, a heading put into a
 * prompt, a label stored for the panel.
 *
 * The code holds the English text. `locales/<locale>.yaml` translates it in
 * its `messages` section, from the English text to the translation, the same
 * section that translates the plugin's UI specs. The host reads those files
 * and gives each handler, guard, tool and RPC action the result as
 * `ctx.messages`.
 *
 * ```js
 * translate(ctx, "World time: {display}", { display: clock.display });
 * labelText(ctx, "Critical success");
 * ```
 *
 * A context with no `messages` (an older host, a context built by hand in a
 * test) gives the English text.
 */
export interface PluginMessages {
  /** English text to its translation in the session's content language. */
  readonly translations: Readonly<Record<string, string>>;
  /** English text to its translation in every language the plugin ships. */
  readonly labels: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The part of a plugin context the text helpers read. */
export interface PluginMessageContext {
  readonly messages?: PluginMessages;
}

/** A value for a `{name}` placeholder. */
export type MessageParams = Readonly<Record<string, string | number>>;

const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/**
 * The text in the session's content language, with each `{name}` replaced
 * from `params`. Use it for text a model or the player reads as part of the
 * session: a notice, a heading in a prompt, a value stored in plugin data
 * that a prompt injects.
 *
 * Pass the English text as a literal, not a variable: the validator finds
 * translations of text the code no longer has by reading the source.
 */
export function translate(
  ctx: PluginMessageContext | undefined,
  text: string,
  params?: MessageParams,
): string {
  const translations = ctx?.messages?.translations;
  const template =
    translations && Object.hasOwn(translations, text)
      ? translations[text]!
      : text;
  if (!params) return template;
  return template.replace(PLACEHOLDER, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/**
 * The text in every language the plugin ships, for data that only the client
 * draws: a badge, a status label. The client picks the player's UI language.
 * Do not store the result in data that a prompt injects; a model would read
 * every language. Use `translate` there.
 */
export function labelText(
  ctx: PluginMessageContext | undefined,
  text: string,
): string | Readonly<Record<string, string>> {
  const labels = ctx?.messages?.labels;
  if (!labels || !Object.hasOwn(labels, text)) return text;
  return { en: text, ...labels[text] };
}
