import { afterEach, describe, expect, it } from "vitest";
import { getImageWire, registerImageWire } from "../src/image/wire-registry.js";
import { getMusicWire, registerMusicWire } from "../src/music/wire-registry.js";
import {
  getSpeechWire,
  getTranscriptionWire,
  registerSpeechWire,
  registerTranscriptionWire,
} from "../src/speech/wire-registry.js";
import { withWireRegistrySnapshot } from "../src/wire-lifecycle.js";
import {
  configureProviderHostPolicy,
  PERSONAL_PROVIDER_HOST_POLICY,
} from "../src/host-policy.js";

/** What the server passes in on `demo` / `commercial`. */
function useSharedHost(): void {
  configureProviderHostPolicy({
    localNetwork: false,
    sessionlessCommunityWires: false,
  });
}

afterEach(() => {
  configureProviderHostPolicy(PERSONAL_PROVIDER_HOST_POLICY);
});

const cases = [
  {
    kind: "image",
    register: (owner: { pluginId: string; builtin: boolean }) =>
      registerImageWire(
        { id: "scope-owner/image", generate: async () => ({}) as never },
        owner,
      ),
    get: (): unknown => getImageWire("scope-owner/image"),
  },
  {
    kind: "speech",
    register: (owner: { pluginId: string; builtin: boolean }) =>
      registerSpeechWire(
        { id: "scope-owner/speech", synthesize: async () => ({}) as never },
        owner,
      ),
    get: (): unknown => getSpeechWire("scope-owner/speech"),
  },
  {
    kind: "transcription",
    register: (owner: { pluginId: string; builtin: boolean }) =>
      registerTranscriptionWire(
        {
          id: "scope-owner/transcription",
          transcribe: async () => ({}) as never,
        },
        owner,
      ),
    get: (): unknown => getTranscriptionWire("scope-owner/transcription"),
  },
  {
    kind: "music",
    register: (owner: { pluginId: string; builtin: boolean }) =>
      registerMusicWire(
        { id: "scope-owner/music", compose: async () => ({}) as never },
        owner,
      ),
    get: (): unknown => getMusicWire("scope-owner/music"),
  },
] as const;

describe("media wires carry their plugin as owner", () => {
  it.each(cases)(
    "a $kind wire serves only sessions in which its plugin is active",
    ({ register, get }) => {
      const dispose = register({ pluginId: "scope-owner", builtin: false });
      try {
        expect(withWireRegistrySnapshot(get, ["scope-owner"])).not.toBeNull();
        expect(withWireRegistrySnapshot(get, ["other"])).toBeNull();
        // No session: a shared host refuses a community plugin's wire.
        useSharedHost();
        expect(get()).toBeNull();
      } finally {
        dispose();
      }
    },
  );

  it("a builtin plugin's wire still needs its plugin in a session", () => {
    const dispose = registerSpeechWire(
      { id: "scope-owner/speech", synthesize: async () => ({}) as never },
      { pluginId: "scope-owner", builtin: true },
    );
    try {
      useSharedHost();
      expect(getSpeechWire("scope-owner/speech")).not.toBeNull();
      expect(
        withWireRegistrySnapshot(
          () => getSpeechWire("scope-owner/speech"),
          ["other"],
        ),
      ).toBeNull();
    } finally {
      dispose();
    }
  });
});
