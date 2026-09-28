/**
 * char-creator plugin discovery tests (multi-runtime).
 *
 * This plugin now hosts two runtimes:
 *   - player-init       — LLM agent, emits the opening char-creation form;
 *                         the real character record is written deterministically
 *                         by guard.js once the player submits, bypassing the LLM.
 *   - character-tracker — LLM agent, detects NPCs and state changes every turn
 *
 * Full execution behavior is covered by E2E tests in apps/server and
 * Playwright tests in apps/web. This file only verifies the manifest
 * structure and discovery so that refactors of the plugin layout fail fast.
 *
 * Run: npx vitest run plugins/char-creator/tests/
 */

import { describe, it, expect, beforeAll } from "vitest";
import path from "node:path";
import fs from "node:fs";
import {
  discoverPlugins,
  loadPluginManifest,
  loadPluginDefinition,
} from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

describe("char-creator plugin", () => {
  let discovery;
  let manifests;
  let root;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    discovery = discoveries.find((d) => d.id === "char-creator");
    expect(discovery).toBeDefined();
    manifests = await loadPluginManifest(discovery);
    root = (await loadPluginDefinition(discovery)).packageManifest.manifest;
  });

  describe("discovery", () => {
    it("is recognized as a multi-runtime plugin", () => {
      expect(discovery.isMultiRuntime).toBe(true);
      expect(discovery.pluginMdPaths.length).toBeGreaterThanOrEqual(2);
    });

    it("exposes player-init and character-tracker runtimes", () => {
      const names = manifests.map((m) => m.manifest.name).sort();
      expect(names).toEqual([
        "char-creator/character-tracker",
        "char-creator/player-init",
      ]);
    });
  });

  describe("player-init runtime", () => {
    let manifest;

    beforeAll(() => {
      const m = manifests.find(
        (x) => x.manifest.name === "char-creator/player-init",
      );
      manifest = m.manifest;
    });

    it("is a setup-stage core-plugin", () => {
      expect(manifest.stage).toBe("setup");
      expect(manifest.pluginType).toBe("core-plugin");
    });

    it("declares only create-character-form — character creation is performed by guard.js, not by the LLM", () => {
      expect(manifest.tools?.plugin).toEqual(["create-character-form"]);
      expect(root.entry).toBe("./server/index.js");
    });

    it("requires one create-character-form call and stops immediately after success", () => {
      expect(manifest.requireToolUse).toBe(true);
      expect(manifest.completeAfterTools).toEqual(["create-character-form"]);
      expect(manifest.maxSteps).toBeUndefined(); // Inherit the framework budget.
      expect(manifest.maxRetries).toBe(0);
    });

    it("injects the same-turn pregame opening and generated world schema", () => {
      // Pre-Game band: narrator is NOT scheduled on turn 0, so player-init
      // consumes the opening summary produced by pregame (priority 10)
      // rather than the (missing) narrator output. See plugin README / the
      // turn-executor scheduler band gate.
      expect(
        (manifest.input?.inject ?? []).some(
          (input) => input.kind === "plugin-data",
        ),
      ).toBe(false);
    });

    it("orders initial setup without requiring completed providers on form submission", () => {
      expect(manifest.needs ?? []).toEqual([]);
      expect(manifest.after).toEqual([
        { capability: "session.opening@1" },
        { capability: "world-data-provider@1" },
      ]);
    });

    it("uses an auto trigger with a guard to gate re-runs", () => {
      // Pre-Game runtimes use `trigger: { type: 'auto' }` and rely on
      // the guard + preGameDone output to opt-out after completion.
      expect(manifest.trigger?.type).toBe("auto");
      expect(manifest.guard).toBeTruthy();
    });

    it("has a guard.js file to skip after player exists", () => {
      const guardPath = path.join(
        discovery.rootPath,
        "runtimes",
        "player-init",
        "guard.js",
      );
      expect(fs.existsSync(guardPath)).toBe(true);
    });

    it("declares the shared character-panel ui spec", () => {
      expect(root.ui?.right).toEqual(
        expect.arrayContaining(["./ui/character-panel.json"]),
      );
    });
  });

  describe("character-tracker runtime", () => {
    let manifest;

    beforeAll(() => {
      const m = manifests.find(
        (x) => x.manifest.name === "char-creator/character-tracker",
      );
      manifest = m.manifest;
    });

    it("runs every turn in the post-turn stage", () => {
      expect(manifest.trigger?.type).toBe("scheduled");
      expect(manifest.trigger?.interval).toBe(1);
      // Band selection is stage-driven: post-turn runs in the main loop, after
      // the narrative stage.
      expect(manifest.stage).toBe("post-turn");
    });

    it("reserves a correction step after the detail read and write", () => {
      expect(manifest.tools?.builtin).toEqual([
        "sync-characters",
        "get-character",
      ]);
      expect(manifest.completeAfterTools).toEqual(["sync-characters"]);
      expect(manifest.tools?.defer).toBeUndefined();
      expect(manifest.maxSteps).toBeUndefined(); // Inherit the framework budget.
      expect(manifest.maxRetries).toBe(0);
    });

    it("does not declare list-characters — the roster is injected", () => {
      // `<existing-characters>` is injected at prompt-build time, so a roster
      // tool would be a round-trip the runtime is told never to make. Handing
      // the model a tool its own prompt forbids costs tokens and invites a
      // detour; `get-character` remains for the truncated-snapshot case.
      expect(manifest.tools?.builtin).not.toContain("list-characters");
      expect(manifest.tools?.builtin).not.toContain("create-character");
      expect(manifest.tools?.builtin).not.toContain("update-character");
      expect(
        (manifest.input?.inject ?? []).some(
          (input) => input.kind === "plugin-data",
        ),
      ).toBe(false);
    });

    it("injects narrativeOutput from both narrative engines ", () => {
      expect(manifest.inputs["narrator-output"]).toEqual({
        from: { capability: "narrative-engine@1" },
        select: "/narrativeOutput",
        required: false,
      });
    });

    it("gates on the narrative-engine capability, not an exact runtime ", () => {
      expect(manifest.needs).toEqual([{ capability: "narrative-engine@1" }]);
    });
  });
});
