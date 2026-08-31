import { standardDirectives } from "@json-render/directives";

/**
 * Dynamic value helpers available to every framework-owned json-render
 * surface. Keep this list centralized so plugin panels and message surfaces
 * interpret the same declarative UI spec in the same way.
 */
export const covelDirectives = [...standardDirectives];
