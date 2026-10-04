import type { EnvVarDefinition } from "../types.js";

export const PACKAGING_ENV_VARS = [
  {
    name: "CSC_LINK",
    group: "packaging",
    type: "secret",
    status: "packaging",
    secret: true,
    description: "electron-builder code-signing certificate path or URL.",
  },
  {
    name: "CSC_KEY_PASSWORD",
    group: "packaging",
    type: "secret",
    status: "packaging",
    secret: true,
    description: "electron-builder code-signing certificate password.",
  },
  {
    name: "WIN_CSC_TIMESTAMP_SERVER",
    group: "packaging",
    type: "url",
    status: "packaging",
    defaultValue: "http://timestamp.digicert.com",
    description: "Windows signing timestamp server.",
  },
  {
    name: "APPLE_ID",
    group: "packaging",
    type: "secret",
    status: "packaging",
    secret: true,
    description: "Apple Developer account for notarization.",
  },
  {
    name: "APPLE_APP_SPECIFIC_PASSWORD",
    group: "packaging",
    type: "secret",
    status: "packaging",
    secret: true,
    description: "electron-builder Apple notarization app-specific password.",
  },
  {
    name: "APPLE_TEAM_ID",
    group: "packaging",
    type: "string",
    status: "packaging",
    description: "Apple Developer Team ID.",
  },
  {
    name: "COVEL_SMOKE_HOST_NODE",
    group: "packaging",
    type: "boolean",
    status: "packaging",
    defaultValue: "false",
    description:
      "Lets the desktop staging smoke run on the host Node with the memory backend when the Electron binary is missing. Native modules are then not verified under Electron.",
  },
] as const satisfies readonly EnvVarDefinition[];
