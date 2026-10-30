import type { GithubPluginPreview, PluginInstallation } from "@covel/shared";

/**
 * Valid response fields for the package install and update endpoints. The web
 * client parses these responses with the shared schemas, so a stubbed
 * response that omits a required field fails there, not in the assertion.
 */
export function packageCapabilities(
  serverCode: boolean,
): GithubPluginPreview["capabilities"] {
  return {
    serverCode,
    http: [],
    hooks: [],
    tools: [],
    actions: [],
    services: [],
    wires: [],
    extensions: [],
    forms: [],
    datasets: [],
  };
}

/** An untouched GitHub installation, as `GET /api/install/{plugins|worlds}` lists it. */
export function verifiedInstallation(
  fields: Pick<PluginInstallation, "id" | "version" | "source"> &
    Partial<Pick<PluginInstallation, "pendingUpdate">>,
): PluginInstallation {
  return {
    integrity: "verified",
    trustedSource: false,
    pendingUpdate: null,
    ...fields,
  };
}
