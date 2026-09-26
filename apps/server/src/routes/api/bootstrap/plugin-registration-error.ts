/** Author-facing registration failures contain no execution or store context. */
export class PluginRegistrationError extends Error {
  readonly code = "plugin_registration_invalid";

  constructor(
    readonly registration: string,
    message: string,
  ) {
    super(`${registration}: ${message}`);
    this.name = "PluginRegistrationError";
  }
}
