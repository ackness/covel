import type { VectorModelOps, VectorStoreCapability } from "./vector-store.js";

/**
 * Vector backend selector and the composed vector-store shape.
 * Production discovers vector support via `supportsVector(store)` directly
 * (see vector-store.ts) — there is no runtime vector-store factory.
 */
export type VectorBackend = "embedded" | "none" | "external";
export type VectorStore = VectorStoreCapability & VectorModelOps;
