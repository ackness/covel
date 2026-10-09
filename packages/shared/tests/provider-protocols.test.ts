import { describe, expect, it } from "vitest";

import {
  BUILTIN_PROVIDER_CONNECTIONS,
  BUILTIN_PROVIDER_PROTOCOLS,
  isBuiltinProviderProtocol,
  isBuiltinTextProtocol,
  isLoopbackBaseUrl,
  listBuiltinProviderConnections,
  protocolOutputModalities,
} from "../src/index.js";

describe("provider protocol descriptors", () => {
  it("separates text protocols from evaluation protocols", () => {
    expect(BUILTIN_PROVIDER_PROTOCOLS.filter(isBuiltinTextProtocol)).toEqual([
      "openai-chat-v1",
      "openai-responses-v1",
      "anthropic-messages-v1",
      "google-generative-ai-v1",
    ]);
    expect(protocolOutputModalities("vercel-evaluation-v4")).toEqual([
      "evaluation",
    ]);
  });

  it("treats a protocol outside the table as text and not built in", () => {
    expect(isBuiltinProviderProtocol("bedrock-converse-v1")).toBe(false);
    expect(isBuiltinTextProtocol("bedrock-converse-v1")).toBe(false);
    expect(protocolOutputModalities("bedrock-converse-v1")).toEqual(["text"]);
    expect(protocolOutputModalities(undefined)).toEqual(["text"]);
  });
});

describe("built-in provider connections", () => {
  it("gives every provider a known protocol and an endpoint of its kind", () => {
    for (const [id, connection] of Object.entries<{
      label: string;
      baseUrl: string;
      protocol: string;
      evaluationProtocol?: string;
      local?: true;
    }>(BUILTIN_PROVIDER_CONNECTIONS)) {
      expect(id, id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(connection.label, id).not.toBe("");
      // A cloud provider is public HTTPS; a local service is on this machine.
      expect(new URL(connection.baseUrl).protocol, id).toBe(
        connection.local ? "http:" : "https:",
      );
      expect(isLoopbackBaseUrl(connection.baseUrl), id).toBe(
        connection.local === true,
      );
      expect(connection.baseUrl, id).not.toMatch(/\/$/);
      expect(isBuiltinProviderProtocol(connection.protocol), id).toBe(true);
      if (connection.evaluationProtocol) {
        expect(
          protocolOutputModalities(connection.evaluationProtocol),
          id,
        ).toEqual(["evaluation"]);
      }
    }
  });

  it("reads only this machine's own addresses as loopback", () => {
    expect(isLoopbackBaseUrl("http://127.0.0.1:3425/v1")).toBe(true);
    expect(isLoopbackBaseUrl("http://[::1]:8080")).toBe(true);
    expect(isLoopbackBaseUrl("http://LOCALHOST:11434/v1")).toBe(true);
    expect(isLoopbackBaseUrl("https://127.0.0.1.example.com/v1")).toBe(false);
    expect(isLoopbackBaseUrl("http://192.168.1.20:11434/v1")).toBe(false);
    expect(isLoopbackBaseUrl("not a url")).toBe(false);
    expect(isLoopbackBaseUrl(undefined)).toBe(false);
  });

  it("lists the providers by product name for a picker", () => {
    const labels = listBuiltinProviderConnections().map(
      (connection) => connection.label,
    );
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
    expect(new Set(labels).size).toBe(labels.length);
  });
});
