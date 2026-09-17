/** Pure plugin-owned validation over a committed form and normalized values. */
export type FormValidator = (
  values: Readonly<Record<string, unknown>>,
  data: unknown,
) => string | undefined;

export type ValidatePluginForm = (request: {
  sessionId: string;
  pluginId: string;
  name: string;
  values: Readonly<Record<string, unknown>>;
  data: unknown;
}) => Promise<string | undefined>;
