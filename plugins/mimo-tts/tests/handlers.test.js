/**
 * L2 — handler tests for auto-narrate and manual-narrate.
 *
 * Mocks ctx.speech.generate (the framework pipeline) so the handlers run
 * end-to-end without touching the network or MediaStore. Wire-level HTTP
 * shape is covered by mimo-tts-wire.test.js.
 *
 * Coverage:
 *   - auto-narrate: skipped when no narrator output; disabled still commits
 *     the Speak-button message-surface record (success, no synthesis)
 *   - auto-narrate: success → pluginData[tracks] + pluginData[message] +
 *     assetGenerations[] (the key the kernel turns into asset.generate)
 *   - auto-narrate: cached hit → autoPlay false, cached recorded
 *   - auto-narrate: failed when ctx.speech is unavailable / generate throws
 *     (message surface still written directly so the button appears)
 *   - manual-narrate: skipped when payload.text is missing (manual
 *     activations resolve no inputs — the button payload is the only source)
 *   - manual-narrate: payload.text + voice/format overrides forwarded
 */

import { describe, it, expect, vi } from "vitest";
import autoHandler from "../runtimes/auto-narrate/handler.js";
import manualHandler from "../runtimes/manual-narrate/handler.js";

function makeMockSpeech({ cached = false } = {}) {
  return {
    generate: vi.fn().mockImplementation(async (input) => ({
      refs: [
        {
          id: "sha256-fake",
          mime: input.format === "wav" ? "audio/wav" : "audio/mpeg",
          size: 4,
          meta: { plugin: "mimo-tts", pluginId: "mimo-tts", promptHash: "h" },
        },
      ],
      warnings: [],
      cached,
    })),
    transcribe: vi.fn(),
  };
}

function makeMockPluginData() {
  const writes = [];
  return {
    writes,
    set: vi.fn().mockImplementation(async (namespace, key, value) => {
      writes.push({ namespace, key, value });
    }),
  };
}

function makeBaseCtx({ narrative, manualPayload, userSettings, speech } = {}) {
  return {
    sessionId: "sess-test",
    pluginId: "mimo-tts",
    turnId: "turn-7",
    runtimeId: "mimo-tts/auto-narrate",
    // Engine-agnostic narrative arrives via the `inputs.narrative` binding
    // (an InputSlot whose `value` is the post-`select` narrativeOutput).
    inputs:
      narrative === undefined
        ? {}
        : {
            narrative: {
              value: narrative,
              source: { runtimeId: "chat-mode-narrator" },
            },
          },
    manualPayload,
    userSettings: userSettings ?? {},
    speech: speech ?? makeMockSpeech(),
    gateway: {
      resolveSlot: vi
        .fn()
        .mockReturnValue({ model: "mimo-v2.5-tts", tag: "speech" }),
    },
    pluginData: makeMockPluginData(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("auto-narrate handler", () => {
  it("commits the Speak-button surface without synthesising when disabled", async () => {
    // enabled=false must NOT skip the run: the turn still needs its
    // message-surface record or the manual Speak button never renders.
    const ctx = makeBaseCtx({
      narrative: "夜风掠过山岗。",
      userSettings: { enabled: false },
    });
    const result = await autoHandler(ctx);
    expect(result.status).toBeUndefined(); // success (proposal path)
    expect(result.autoSynthesis).toBe("disabled-by-user-setting");
    expect(result.pluginData).toEqual([
      {
        namespace: "message",
        key: "turn-7",
        value: { turnId: "turn-7", text: "夜风掠过山岗。" },
      },
    ]);
    expect(ctx.speech.generate).not.toHaveBeenCalled();
  });

  it("skips when the narrative engine produced no narrativeOutput", async () => {
    const ctx = makeBaseCtx();
    const result = await autoHandler(ctx);
    expect(result.status).toBe("skipped");
    expect(ctx.speech.generate).not.toHaveBeenCalled();
  });

  it("fails with an upgrade hint when ctx.speech is unavailable", async () => {
    // Narrative present (the probe sits after text/disabled checks so the
    // surface-only path never demands a speech pipeline).
    const ctx = makeBaseCtx({ narrative: "夜风掠过山岗。" });
    ctx.speech = undefined;
    const result = await autoHandler(ctx);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/ctx\.speech is unavailable/);
  });

  it("synthesises via ctx.speech.generate and emits an asset on success", async () => {
    const ctx = makeBaseCtx({ narrative: "夜风掠过山岗，月色洒在湖面。" });

    const result = await autoHandler(ctx);

    expect(result.status).toBe("done");
    expect(result.trackId).toBe("tts-auto-turn-7");
    expect(result.ref.id).toBe("sha256-fake");
    // assetGenerations is the key normalizeOutput collects into
    // asset.generate proposals (a returned `assets` key is silently ignored).
    expect(result.assetGenerations).toHaveLength(1);
    expect(result.assetGenerations[0].modality).toBe("audio");
    // Speak-button surface rides the same proposal batch as the track.
    expect(result.pluginData).toContainEqual({
      namespace: "message",
      key: "turn-7",
      value: { turnId: "turn-7", text: "夜风掠过山岗，月色洒在湖面。" },
    });
    expect(result.pluginData[0].namespace).toBe("tracks");
    expect(result.pluginData[0].value.triggeredBy).toBe("auto");
    expect(result.pluginData[0].value.autoPlay).toBe(true);
    expect(result.pluginData[0].value.cached).toBe(false);
    expect(result.pluginData[0].value.model).toBe("mimo-v2.5-tts");

    // Display fields the right-panel spec binds against
    expect(result.pluginData[0].value.turnLabel).toBe("Turn 7");
    expect(result.pluginData[0].value.triggerLabel).toBe("AUTO");
    expect(result.pluginData[0].value.textPreview).toBe(
      "夜风掠过山岗，月色洒在湖面。",
    );
    expect(result.pluginData[0].value.sizeLabel).toBe("4 B");

    // Pending state is logged but NOT written to plugin-data — Tab only
    // ever shows done/failed so the <Media> placeholder never appears.
    expect(ctx.pluginData.set).toHaveBeenCalledTimes(1);
    expect(ctx.pluginData.set.mock.calls[0][2].status).toBe("done");

    expect(ctx.speech.generate).toHaveBeenCalledWith(
      expect.objectContaining({
        presetId: "mimo-tts",
        text: "夜风掠过山岗，月色洒在湖面。",
        voice: "mimo_default",
        format: "mp3",
      }),
    );
  });

  it("does not auto-play a cached (deduped) track", async () => {
    const ctx = makeBaseCtx({
      narrative: "同一段文字。",
      speech: makeMockSpeech({ cached: true }),
    });

    const result = await autoHandler(ctx);

    expect(result.status).toBe("done");
    expect(result.pluginData[0].value.cached).toBe(true);
    expect(result.pluginData[0].value.autoPlay).toBe(false);
  });

  it("returns a failure record when the pipeline throws", async () => {
    const ctx = makeBaseCtx({ narrative: "test" });
    ctx.speech.generate.mockRejectedValue(
      new Error(
        'unknown speech wire "ghost" — register it via registerSpeechWire()',
      ),
    );

    const result = await autoHandler(ctx);
    expect(result.status).toBe("failed");
    expect(result.error).toMatch(/unknown speech wire/);
    expect(ctx.pluginData.set.mock.calls[0][2].status).toBe("failed");
    // The Speak button still appears for the turn: the message-surface
    // record is written directly (a failed result commits no proposals).
    expect(ctx.pluginData.set).toHaveBeenCalledWith("message", "turn-7", {
      turnId: "turn-7",
      text: "test",
    });
  });
});

describe("manual-narrate handler", () => {
  it("skips when payload.text is missing (manual activations carry no inputs)", async () => {
    // Even with engine narrative present, a manual activation resolves no
    // turn bindings — there is no fallback; the button payload is the only
    // text source.
    const ctx = makeBaseCtx({ narrative: "不可达的兜底", manualPayload: {} });
    const result = await manualHandler(ctx);
    expect(result.status).toBe("skipped");
    expect(result.reason).toMatch(/payload\.text is required/);
    expect(ctx.speech.generate).not.toHaveBeenCalled();
  });

  it("speaks payload.text (assetGenerations emitted)", async () => {
    const ctx = makeBaseCtx({
      manualPayload: { text: "请只朗读这一段", turnId: "turn-7" },
    });
    const result = await manualHandler(ctx);
    expect(result.assetGenerations).toHaveLength(1);
    expect(result.assetGenerations[0].modality).toBe("audio");

    expect(result.status).toBe("done");
    expect(result.pluginData[0].value.triggeredBy).toBe("manual");
    expect(result.pluginData[0].value.autoPlay).toBe(false);
    expect(result.pluginData[0].value.triggerLabel).toBe("MANUAL");
    expect(result.pluginData[0].value.textPreview).toBe("请只朗读这一段");

    expect(ctx.speech.generate).toHaveBeenCalledWith(
      expect.objectContaining({ text: "请只朗读这一段" }),
    );
  });

  it("honors per-call payload overrides for voice / format", async () => {
    const ctx = makeBaseCtx({
      manualPayload: { text: "hello", voice: "voice-clone-42", format: "wav" },
    });
    const result = await manualHandler(ctx);
    expect(result.status).toBe("done");

    expect(ctx.speech.generate).toHaveBeenCalledWith(
      expect.objectContaining({ voice: "voice-clone-42", format: "wav" }),
    );
    expect(result.ref.mime).toBe("audio/wav");
  });
});
