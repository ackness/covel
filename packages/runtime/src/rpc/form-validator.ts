/**
 * Pure plugin-owned validation over a committed form and normalized values.
 * The returned text is shown to the player: `context` carries the session's
 * language and the plugin's translations for it, the shape `translate` takes.
 */
export type FormValidator = (
  values: Readonly<Record<string, unknown>>,
  data: unknown,
  context: {
    readonly locale: string;
    readonly messages?: import("@covel/shared").PluginMessages;
  },
) => string | undefined;

export type ValidatePluginForm = (request: {
  sessionId: string;
  pluginId: string;
  name: string;
  values: Readonly<Record<string, unknown>>;
  data: unknown;
}) => Promise<string | undefined>;
