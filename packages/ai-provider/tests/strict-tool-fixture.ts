import type { StrictToolCapability, StrictToolProfile } from "../src/index.js";

/** Synthetic limits for deterministic tests; no live provider support claim. */
export const strictProfile: StrictToolProfile = {
  id: "synthetic-closed-objects",
  keywords: [
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "enum",
    "description",
  ],
  root: "object",
  requireAllProperties: true,
  closedObjects: true,
  references: "none",
  typeUnions: false,
  booleanSchemas: false,
  formats: [],
  maxBytes: 10000,
  maxDepth: 10,
  maxProperties: 30,
  maxEnumValues: 30,
};
export const closedSchema = {
  type: "object",
  properties: { ok: { type: "boolean" } },
  required: ["ok"],
  additionalProperties: false,
};
export const strictCapability: StrictToolCapability = {
  provider: "fixture",
  model: "synthetic",
  protocol: "openai-chat-v1",
  baseUrl: "https://fixture.invalid/v1",
  profile: strictProfile,
};
