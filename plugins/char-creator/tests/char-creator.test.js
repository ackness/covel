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
import { discoverPlugins, loadPluginManifest } from "@covel/plugin-loader";

const PLUGINS_DIR = path.resolve(import.meta.dirname, "../..");

describe("char-creator plugin", () => {
  let discovery;
  let manifests;

  beforeAll(async () => {
    const discoveries = await discoverPlugins(PLUGINS_DIR);
    discovery = discoveries.find((d) => d.id === "char-creator");
    expect(discovery).toBeDefined();
    manifests = await loadPluginManifest(discovery);
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

    it("is a Pre-Game band core-plugin (priority < 100)", () => {
      expect(manifest.priority).toBeLessThan(100);
      expect(manifest.pluginType).toBe("core-plugin");
    });

    it("declares only create-form — character creation is performed by guard.js, not by the LLM", () => {
      expect(manifest.tools?.builtin).toEqual(["create-form"]);
    });

    it("injects pregame.narrativeOutput as <pregame-opening>", () => {
      // Pre-Game band: narrator is NOT scheduled on turn 0, so player-init
      // consumes the opening summary produced by pregame (priority 10)
      // rather than the (missing) narrator output. See plugin README / the
      // turn-executor scheduler band gate.
      expect(manifest.input?.inject).toHaveLength(1);
      const inject = manifest.input.inject[0];
      expect(inject.from).toBe("pregame");
      expect(inject.field).toBe("narrativeOutput");
      expect(inject.as).toBe("<pregame-opening>");
    });

    it("declares upstreamRequired so it waits for pregame and schema init", () => {
      expect(manifest.upstreamRequired).toEqual([
        "pregame",
        "world-init/schema-gen",
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
      expect(manifest.ui?.right).toEqual(
        expect.arrayContaining(["../../ui/character-panel.json"]),
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

    it("runs every turn in the main-loop band (priority >= 100)", () => {
      expect(manifest.trigger?.type).toBe("scheduled");
      expect(manifest.trigger?.interval).toBe(1);
      // Band filtering (Pre-Game vs main loop) is enforced server-side by
      // the priority scheduler based on `session.turnCount`. The manifest
      // no longer carries a `trigger.phases` field.
      expect(manifest.priority).toBeGreaterThanOrEqual(100);
    });

    it("declares the full character management tool suite", () => {
      expect(manifest.tools?.builtin).toEqual(
        expect.arrayContaining([
          "create-character",
          "update-character",
          "list-characters",
          "get-character",
        ]),
      );
    });

    it("injects narrativeOutput from both narrative engines (H-04)", () => {
      // Engine-agnostic: one inject per known narrative engine; the absent
      // engine resolves to nothing so exactly the active one fills the block.
      expect(manifest.input?.inject).toHaveLength(2);
      for (const engine of ["narrator", "chat-mode-narrator"]) {
        expect(manifest.input.inject).toContainEqual({
          kind: "runtime",
          from: engine,
          field: "narrativeOutput",
          as: "<narrator-output>",
        });
      }
    });

    it("gates on the narrative-engine capability, not an exact runtime (H-04)", () => {
      expect(manifest.upstreamRequired).toEqual([
        { capability: "narrative-engine" },
      ]);
    });
  });
});
