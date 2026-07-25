import { describe, it, expect, vi } from "vitest";
import {
  FrameworkCapability,
  FrameworkRuntimeCapability,
  FRAMEWORK_KNOWN_CAPABILITIES,
} from "@covel/shared";
import { parsePluginMd } from "../src/parse-plugin-md.js";
import { normalizeRuntimeManifest } from "../src/normalize.js";

// ── Helpers ──────────────────────────────────────────────────────

function md(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

// ── Tests ────────────────────────────────────────────────────────

describe("parsePluginMd", () => {
  describe("deprecated `config` field", () => {
    it("strips `config` with a warning instead of failing the strict load", () => {
      const content = md(
        [
          "name: legacy-config-plugin",
          "description: A plugin written against the old docs",
          "stage: narrative",
          "trigger:",
          "  type: auto",
          "config:",
          "  difficulty:",
          "    type: enum",
          "    default: normal",
          "    options: [easy, normal, hard]",
        ].join("\n"),
        "\nBody.\n",
      );

      // Must not throw — `config` was removed in favour of `userSettings`, but a
      // straggler PLUGIN.md should get a deprecation cycle, not a hard crash.
      const result = parsePluginMd(content, "plugins/legacy/PLUGIN.md");
      expect(result.manifest.name).toBe("legacy-config-plugin");
      expect(
        (result.manifest as Record<string, unknown>).config,
      ).toBeUndefined();
    });
  });

  describe("contribution-only manifest (hook / UI plugin, no runtime shape)", () => {
    it("parses a manifest with no runtimeType / handler / trigger / priority", () => {
      // A hook-only (director / cost-gate) or UI-only (memory) plugin carries
      // no schedulable runtime — its behaviour lives in an `entry` module or a
      // `ui` spec. The manifest must load cleanly without any runtime shape.
      const content = md(
        [
          "name: hook-only-plugin",
          "description: A cross-cutting hook plugin",
          "pluginType: plugin",
          "outputKind: system",
          "capabilities:",
          "  - content-safety",
          "entry: ./server/index.js",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/hook-only/PLUGIN.md");
      expect(result.manifest.name).toBe("hook-only-plugin");
      expect(result.manifest.runtimeType).toBeUndefined();
      expect(result.manifest.handler).toBeUndefined();
      expect(result.manifest.trigger).toBeUndefined();
      expect(result.manifest.priority).toBeUndefined();
      expect(result.manifest.entry).toBe("./server/index.js");
    });

    it("normalizes to a non-schedulable spec (default auto, no stage, no legacyOrder)", () => {
      const content = md(
        [
          "name: ui-only-plugin",
          "description: A pure UI panel plugin",
          "pluginType: core-plugin",
          "outputKind: system",
          "ui:",
          "  right:",
          "    - ./ui/panel.json",
        ].join("\n"),
        "\nBody.\n",
      );

      const { manifest } = parsePluginMd(content, "plugins/ui-only/PLUGIN.md");
      const spec = normalizeRuntimeManifest(manifest);
      // Omitted trigger folds to the default `auto`, but with no priority the
      // spec gets no stage and no legacyOrder — the scheduler keys on
      // legacyOrder (priority) and drops a priority-less runtime, so this
      // manifest is never enqueued despite the auto default.
      expect(spec.declaredTrigger.type).toBe("auto");
      expect(spec.stage).toBeUndefined();
      expect(spec.legacyOrder).toBeUndefined();
    });
  });

  describe("minimal PLUGIN.md", () => {
    it("should parse name, description, priority and body", () => {
      const content = md(
        [
          "name: narrator",
          "description: Main narrative generation",
          "stage: pre-turn",
        ].join("\n"),
        "\nYou are the narrator of an RPG story.\n",
      );

      const result = parsePluginMd(content, "plugins/narrator/PLUGIN.md");

      expect(result.manifest.name).toBe("narrator");
      expect(result.manifest.description).toBe("Main narrative generation");
      expect(result.manifest.stage).toBe("pre-turn");
      expect(result.promptTemplate).toBe(
        "\nYou are the narrator of an RPG story.\n",
      );
      expect(result.rawFrontmatter).toEqual({
        name: "narrator",
        description: "Main narrative generation",
        stage: "pre-turn",
      });
    });
  });

  describe("i18n description + hooks coexistence (regression)", () => {
    // A plugin that declares BOTH an object i18n `description` and `hooks` must
    // still have its description collapsed to a string. The hooks-rebuild step
    // previously spread from the raw frontmatter and clobbered the normalized
    // description back to an object, failing schema validation. cost-gate was
    // the first plugin to hit this (object description + hooks).
    it("normalizes object description to a string when hooks are also present", () => {
      const content = md(
        [
          "name: cost-gate",
          "description:",
          "  zh: 中文描述",
          "  en: English description",
          "runtimeType: function",
          "trigger:",
          "  type: manual",
          "hooks:",
          "  - event: TurnStart",
          "    handler: ./hooks/a.js",
          "  - event: SessionEnd",
          "    handler: ./hooks/b.js",
        ].join("\n"),
        "\nbody\n",
      );

      const result = parsePluginMd(content, "plugins/cost-gate/PLUGIN.md");

      // Prefer English (ASCII-friendly for traces), per the normalizer.
      expect(result.manifest.description).toBe("English description");
      expect(result.manifest.hooks).toEqual([
        { event: "TurnStart", handler: "./hooks/a.js" },
        { event: "SessionEnd", handler: "./hooks/b.js" },
      ]);
    });
  });

  describe("full frontmatter", () => {
    it("should parse all optional fields", () => {
      const content = md(
        [
          "name: combat",
          "description: Structured turn-based combat",
          'version: "1.0.0"',
          "model: balance",
          "trigger:",
          "  type: event",
          "  topic: combat-start",
          "tools:",
          "  builtin:",
          "    - state.get",
          "    - state.patch",
          "  plugin:",
          "    - roll-dice",
          "input:",
          "  inject:",
          "    - kind: runtime",
          "      from: narrator",
          "      field: narrativeOutput",
          "      as: narrativeContext",
          "output:",
          "  schema: combat-result",
          "  recordAs: combat-log",
          "dataSchemas:",
          "  relationships:",
          "    schemaVersion: 1",
          "    acceptsWorldData: true",
          "    schema: ./schemas/relationships.schema.json",
          "    description: Relationship graph",
          "tags:",
          "  - mode:traditional-story",
          "  - role:narrator",
          "relations:",
          "  provides:",
          "    - narrative-engine",
          "  conflicts:",
          "    - chat-mode-narrator",
        ].join("\n"),
        "\nHandle combat encounters.\n",
      );

      const result = parsePluginMd(content, "plugins/combat/PLUGIN.md");

      expect(result.manifest.name).toBe("combat");
      expect(result.manifest.version).toBe("1.0.0");
      expect(result.manifest.tags).toEqual([
        "mode:traditional-story",
        "role:narrator",
      ]);
      expect(result.manifest.relations?.provides).toEqual(["narrative-engine"]);
      expect(result.manifest.model).toBe("balance");
      expect(result.manifest.trigger).toEqual({
        type: "event",
        topic: "combat-start",
      });
      expect(result.manifest.tools).toEqual({
        builtin: ["state.get", "state.patch"],
        plugin: ["roll-dice"],
      });
      expect(result.manifest.input).toEqual({
        inject: [
          {
            kind: "runtime",
            from: "narrator",
            field: "narrativeOutput",
            as: "narrativeContext",
          },
        ],
      });
      expect(result.manifest.output).toEqual({
        schema: "combat-result",
        recordAs: "combat-log",
      });
      expect(result.manifest.dataSchemas).toEqual({
        relationships: {
          namespace: "relationships",
          schemaVersion: 1,
          acceptsWorldData: true,
          schema: "./schemas/relationships.schema.json",
          description: "Relationship graph",
        },
      });
    });
  });

  describe("tools.defer", () => {
    it("accepts defer: true (defer the whole whitelist)", () => {
      const content = md(
        [
          "name: scene-stage",
          "description: Scene stage",
          "tools:",
          "  builtin:",
          "    - plugin-data-get",
          "  defer: true",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/scene-stage/PLUGIN.md");
      expect(result.manifest.tools).toEqual({
        builtin: ["plugin-data-get"],
        defer: true,
      });
    });

    it("accepts defer: [names] (defer a subset)", () => {
      const content = md(
        [
          "name: scene-stage",
          "description: Scene stage",
          "tools:",
          "  builtin:",
          "    - plugin-data-get",
          "    - plugin-data-set",
          "  defer:",
          "    - plugin-data-set",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/scene-stage/PLUGIN.md");
      expect(result.manifest.tools?.defer).toEqual(["plugin-data-set"]);
    });
  });

  describe("input.inject — plugin-data source", () => {
    it("parses a plugin-data inject with explicit format and maxEntries", () => {
      const content = md(
        [
          "name: codex",
          "description: Knowledge codex",
          "stage: post-turn",
          "input:",
          "  inject:",
          "    - kind: plugin-data",
          "      namespace: entries",
          '      as: "<existing-entries>"',
          "      format: summary",
          "      maxEntries: 100",
        ].join("\n"),
        "\ncodex body\n",
      );

      const result = parsePluginMd(content, "plugins/codex/PLUGIN.md");

      expect(result.manifest.input).toEqual({
        inject: [
          {
            kind: "plugin-data",
            namespace: "entries",
            as: "<existing-entries>",
            format: "summary",
            maxEntries: 100,
          },
        ],
      });
    });

    it("fills plugin-data defaults when format / maxEntries omitted", () => {
      const content = md(
        [
          "name: codex",
          "description: Knowledge codex",
          "stage: post-turn",
          "input:",
          "  inject:",
          "    - kind: plugin-data",
          "      namespace: entries",
          '      as: "<existing-entries>"',
        ].join("\n"),
        "\ncodex body\n",
      );

      const result = parsePluginMd(content, "plugins/codex/PLUGIN.md");

      expect(result.manifest.input?.inject?.[0]).toEqual({
        kind: "plugin-data",
        namespace: "entries",
        as: "<existing-entries>",
        format: "summary",
        maxEntries: 50,
      });
    });

    it("allows mixing runtime + plugin-data injects in one list", () => {
      const content = md(
        [
          "name: codex",
          "description: Knowledge codex",
          "stage: post-turn",
          "input:",
          "  inject:",
          "    - kind: runtime",
          "      from: narrator",
          "      field: narrativeOutput",
          '      as: "<narrator-output>"',
          "    - kind: plugin-data",
          "      namespace: entries",
          '      as: "<existing-entries>"',
          "      format: ids-only",
          "      maxEntries: 20",
        ].join("\n"),
        "\ncodex body\n",
      );

      const result = parsePluginMd(content, "plugins/codex/PLUGIN.md");
      const injects = result.manifest.input?.inject ?? [];
      expect(injects).toHaveLength(2);
      expect(injects[0]).toMatchObject({
        kind: "runtime",
        from: "narrator",
        field: "narrativeOutput",
      });
      expect(injects[1]).toMatchObject({
        kind: "plugin-data",
        namespace: "entries",
        format: "ids-only",
        maxEntries: 20,
      });
    });

    it("rejects maxEntries outside [1, 500]", () => {
      const content = md(
        [
          "name: codex",
          "description: Knowledge codex",
          "stage: post-turn",
          "input:",
          "  inject:",
          "    - kind: plugin-data",
          "      namespace: entries",
          '      as: "<existing-entries>"',
          "      maxEntries: 9999",
        ].join("\n"),
        "\nbody\n",
      );
      expect(() => parsePluginMd(content, "plugins/codex/PLUGIN.md")).toThrow();
    });

    it("rejects invalid namespace characters", () => {
      const content = md(
        [
          "name: codex",
          "description: Knowledge codex",
          "stage: post-turn",
          "input:",
          "  inject:",
          "    - kind: plugin-data",
          '      namespace: "invalid namespace with spaces"',
          '      as: "<existing-entries>"',
        ].join("\n"),
        "\nbody\n",
      );
      expect(() => parsePluginMd(content, "plugins/codex/PLUGIN.md")).toThrow();
    });
  });

  describe("template variables", () => {
    it("should preserve template variables as-is", () => {
      const body = [
        "",
        "## Context",
        "",
        "{{ inputs.narrator.main.narrativeOutput }}",
        "",
        "Continue the story based on the above.",
        "",
      ].join("\n");

      const content = md(
        ["name: guide", "description: Story guidance", "stage: post-turn"].join(
          "\n",
        ),
        body,
      );

      const result = parsePluginMd(content, "plugins/guide/PLUGIN.md");

      expect(result.promptTemplate).toContain(
        "{{ inputs.narrator.main.narrativeOutput }}",
      );
    });
  });

  describe("invalid frontmatter", () => {
    it("should throw when required fields are missing", () => {
      // description is required but missing
      const content = md(["name: core-test"].join("\n"), "\nBody text.\n");

      expect(() =>
        parsePluginMd(content, "plugins/core-test/PLUGIN.md"),
      ).toThrow();
    });

    it("should include file path in error message", () => {
      const content = md("name: core-test", "\nBody.\n");

      expect(() =>
        parsePluginMd(content, "plugins/core-test/PLUGIN.md"),
      ).toThrow(/core-test/);
    });
  });

  describe("diagnostic error messages (D-4)", () => {
    it("error contains [plugin-loader] prefix, plugin path and a Fix: hint", () => {
      // Missing `description` — a required field.
      const content = md(
        ["name: core-needs-desc", "stage: pre-turn"].join("\n"),
        "\nBody.\n",
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, "plugins/core-needs-desc/PLUGIN.md");
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toContain("[plugin-loader]");
      expect(caught!.message).toContain("plugins/core-needs-desc/PLUGIN.md");
      expect(caught!.message).toContain("Fix:");
      // Authoring-facing hint for the specific missing field.
      expect(caught!.message.toLowerCase()).toContain("description");
    });

    it("error for bad `name` format points at the name field with a kebab-case Fix hint", () => {
      const content = md(
        [
          "name: BadName",
          "description: Invalid name shape",
          "stage: pre-turn",
        ].join("\n"),
        "\nBody.\n",
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, "plugins/bad-name/PLUGIN.md");
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(
        /\[plugin-loader\].*plugins\/bad-name\/PLUGIN\.md/,
      );
      expect(caught!.message).toContain("Fix:");
      // The tailored hint for bad `name` mentions kebab-case.
      expect(caught!.message.toLowerCase()).toContain("kebab-case");
    });

    it("includes a 1-based line number when the failing key appears in source", () => {
      const content = md(
        [
          "name: core-line",
          "description: Line test",
          // stage must be one of the five band names — force a Zod error.
          "stage: not-a-stage",
        ].join("\n"),
        "\nBody.\n",
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, "plugins/core-line/PLUGIN.md");
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      // `stage:` is the 4th line of the document (1: ---, 2: name, 3: description, 4: stage).
      expect(caught!.message).toMatch(/plugins\/core-line\/PLUGIN\.md:4:/);
      expect(caught!.message).toContain("Fix:");
    });
  });

  describe("empty body", () => {
    it("should return empty string for promptTemplate", () => {
      const content = md(
        [
          "name: core-empty",
          "description: Empty body plugin",
          "stage: narrative",
        ].join("\n"),
        "",
      );

      const result = parsePluginMd(content, "plugins/core-empty/PLUGIN.md");

      expect(result.promptTemplate).toBe("");
      expect(result.manifest.name).toBe("core-empty");
    });
  });

  describe("timeoutMs: runtime field", () => {
    it("parses a valid runtime timeout override", () => {
      const content = md(
        [
          "name: test-slow-runtime",
          "description: Runtime with custom timeout",
          "stage: narrative",
          "timeoutMs: 180000",
        ].join("\n"),
        "\nBody text.\n",
      );

      const result = parsePluginMd(
        content,
        "plugins/test-slow-runtime/PLUGIN.md",
      );

      expect(result.manifest.timeoutMs).toBe(180000);
    });
  });

  describe("hooks: field", () => {
    it("parses a valid hooks declaration with all optional fields", () => {
      const content = md(
        [
          "name: test-guard-plugin",
          "description: Plugin with hooks",
          "stage: narrative",
          "hooks:",
          "  - event: PreToolUse",
          "    handler: ./hooks/validate.ts",
          "    timeoutMs: 3000",
          "    enforce: pre",
          "    match:",
          "      tool: create-character",
          "  - event: PostStateCommit",
          "    handler: ./hooks/audit.ts",
        ].join("\n"),
        "\nGuard plugin body.\n",
      );

      const result = parsePluginMd(
        content,
        "plugins/test-guard-plugin/PLUGIN.md",
      );

      expect(result.manifest.hooks).toHaveLength(2);
      expect(result.manifest.hooks![0]).toMatchObject({
        event: "PreToolUse",
        handler: "./hooks/validate.ts",
        timeoutMs: 3000,
        enforce: "pre",
        match: { tool: "create-character" },
      });
      expect(result.manifest.hooks![1]).toMatchObject({
        event: "PostStateCommit",
        handler: "./hooks/audit.ts",
      });
    });

    it("parses all 16 valid hook event names", () => {
      const validEvents = [
        "SessionStart",
        "SessionEnd",
        "TurnStart",
        "PreCompaction",
        "PostCompaction",
        "PreSchedule",
        "PreRuntime",
        "PostContextAssembly",
        "PreLLMCall",
        "PostLLMResponse",
        "PostRuntime",
        "PreToolUse",
        "PostToolUse",
        "PreStateCommit",
        "PostStateCommit",
        "TurnStop",
      ];

      for (const event of validEvents) {
        const content = md(
          [
            "name: test-hook-plugin",
            "description: Hook event test",
            "stage: narrative",
            "hooks:",
            `  - event: ${event}`,
            "    handler: ./hooks/handler.ts",
          ].join("\n"),
          "\nBody.\n",
        );

        const result = parsePluginMd(
          content,
          "plugins/test-hook-plugin/PLUGIN.md",
        );
        expect(result.manifest.hooks![0].event).toBe(event);
      }
    });

    it("skips invalid hook event with warning and returns only valid entries", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-bad-hook",
          "description: Bad hook event",
          "stage: narrative",
          "hooks:",
          "  - event: InvalidEvent",
          "    handler: ./hooks/bad.ts",
          "  - event: PreToolUse",
          "    handler: ./hooks/good.ts",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-bad-hook/PLUGIN.md");

      // Warning emitted for the invalid event
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain("InvalidEvent");
      expect(warnSpy.mock.calls[0][0]).toContain(
        "plugins/test-bad-hook/PLUGIN.md",
      );

      // Only the valid entry survives
      expect(result.manifest.hooks).toHaveLength(1);
      expect(result.manifest.hooks![0].event).toBe("PreToolUse");

      warnSpy.mockRestore();
    });

    it("returns hooks: undefined when all hook entries have invalid events", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-all-bad-hooks",
          "description: All bad hook events",
          "stage: narrative",
          "hooks:",
          "  - event: Bogus",
          "    handler: ./hooks/bad.ts",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(
        content,
        "plugins/test-all-bad-hooks/PLUGIN.md",
      );

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.hooks).toBeUndefined();

      warnSpy.mockRestore();
    });

    it("skips malformed hook entry with warning and keeps valid siblings (review I1)", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-malformed-hook",
          "description: Mix of valid + malformed entries",
          "stage: narrative",
          "hooks:",
          "  - event: PreToolUse",
          "    handler: ./hooks/ok.ts",
          "  - event: PreToolUse",
          "    handler: 42", // numeric handler — invalid type
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(
        content,
        "plugins/test-malformed-hook/PLUGIN.md",
      );

      expect(warnSpy).toHaveBeenCalledOnce();
      const warnMsg = warnSpy.mock.calls[0][0] as string;
      expect(warnMsg).toContain("malformed hook entry skipped");
      expect(result.manifest.hooks).toHaveLength(1);
      expect(result.manifest.hooks![0].handler).toBe("./hooks/ok.ts");

      warnSpy.mockRestore();
    });

    it("enables hooks whenever hooks are declared", () => {
      const content = md(
        [
          "name: test-hooks",
          "description: Hooks declaration",
          "stage: narrative",
          "hooks:",
          "  - event: PreToolUse",
          "    handler: ./hooks/ok.ts",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-hooks/PLUGIN.md");

      expect(result.manifest.hooks).toEqual([
        {
          event: "PreToolUse",
          handler: "./hooks/ok.ts",
        },
      ]);
    });

    it("parses plugin without hooks field (optional)", () => {
      const content = md(
        [
          "name: no-hooks-plugin",
          "description: Plugin without hooks",
          "stage: narrative",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(
        content,
        "plugins/no-hooks-plugin/PLUGIN.md",
      );
      expect(result.manifest.hooks).toBeUndefined();
    });
  });

  describe("authorsNote field", () => {
    it("parses a minimal authorsNote declaration", () => {
      const content = md(
        [
          "name: test-note",
          "description: Author note plugin",
          "stage: narrative",
          "authorsNote:",
          "  content: Stay in character and keep pacing tight.",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-note/PLUGIN.md");
      expect(result.manifest.authorsNote).toEqual({
        content: "Stay in character and keep pacing tight.",
      });
    });

    it("parses authorsNote with depth and role", () => {
      const content = md(
        [
          "name: test-note",
          "description: Full note",
          "stage: narrative",
          "authorsNote:",
          "  content: Director note body",
          "  depth: 2",
          "  role: user",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-note/PLUGIN.md");
      expect(result.manifest.authorsNote).toEqual({
        content: "Director note body",
        depth: 2,
        role: "user",
      });
    });

    it("skips malformed authorsNote with warning and preserves other fields", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-bad-note",
          "description: Bad note shape",
          "stage: narrative",
          "authorsNote:",
          '  content: "valid"',
          "  depth: not-a-number",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-bad-note/PLUGIN.md");

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain(
        "malformed authorsNote skipped",
      );
      expect(result.manifest.authorsNote).toBeUndefined();
      // Other fields still parsed correctly
      expect(result.manifest.name).toBe("test-bad-note");
      expect(result.manifest.stage).toBe("narrative");

      warnSpy.mockRestore();
    });

    it("rejects authorsNote with unknown role", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-bad-role",
          "description: Unknown role",
          "stage: narrative",
          "authorsNote:",
          '  content: "valid content"',
          "  role: tool",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-bad-role/PLUGIN.md");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.authorsNote).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe("postHistory field", () => {
    it("parses a minimal postHistory declaration", () => {
      const content = md(
        [
          "name: test-post",
          "description: Post history plugin",
          "stage: narrative",
          "postHistory:",
          "  content: Always respond in markdown.",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-post/PLUGIN.md");
      expect(result.manifest.postHistory).toEqual({
        content: "Always respond in markdown.",
      });
    });

    it("parses postHistory with role override", () => {
      const content = md(
        [
          "name: test-post",
          "description: Full post",
          "stage: narrative",
          "postHistory:",
          "  content: Final instructions",
          "  role: user",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-post/PLUGIN.md");
      expect(result.manifest.postHistory).toEqual({
        content: "Final instructions",
        role: "user",
      });
    });

    it("skips malformed postHistory with warning and preserves other fields", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const content = md(
        [
          "name: test-bad-post",
          "description: Bad shape",
          "stage: narrative",
          "postHistory:",
          "  content: 42",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-bad-post/PLUGIN.md");

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain(
        "malformed postHistory skipped",
      );
      expect(result.manifest.postHistory).toBeUndefined();
      expect(result.manifest.name).toBe("test-bad-post");

      warnSpy.mockRestore();
    });

    it("parses both authorsNote and postHistory together", () => {
      const content = md(
        [
          "name: test-both",
          "description: Both fields",
          "stage: narrative",
          "authorsNote:",
          "  content: Director",
          "  depth: 3",
          "postHistory:",
          "  content: Final",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-both/PLUGIN.md");
      expect(result.manifest.authorsNote?.content).toBe("Director");
      expect(result.manifest.authorsNote?.depth).toBe(3);
      expect(result.manifest.postHistory?.content).toBe("Final");
    });

    it("omitting both fields yields undefined", () => {
      const content = md(
        [
          "name: test-none",
          "description: No note fields",
          "stage: narrative",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/test-none/PLUGIN.md");
      expect(result.manifest.authorsNote).toBeUndefined();
      expect(result.manifest.postHistory).toBeUndefined();
    });
  });

  describe("rpc field", () => {
    it("parses a single rpc action declaration", () => {
      const content = md(
        [
          "name: test-rpc",
          "description: RPC plugin",
          "stage: narrative",
          "rpc:",
          "  regenerate:",
          "    handler: ./rpc/regenerate.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-rpc/PLUGIN.md");
      expect(result.manifest.rpc).toEqual({
        regenerate: { handler: "./rpc/regenerate.js" },
      });
    });

    it("parses multiple rpc actions with full options", () => {
      const content = md(
        [
          "name: test-rpc-full",
          "description: Full RPC plugin",
          "stage: narrative",
          "rpc:",
          "  regenerate:",
          "    handler: ./rpc/regenerate.js",
          "    description: Re-run last narrator output",
          "  cancel:",
          "    handler: ./rpc/cancel.js",
          "    trustLevel: builtin",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-rpc-full/PLUGIN.md");
      expect(result.manifest.rpc?.regenerate).toEqual({
        handler: "./rpc/regenerate.js",
        description: "Re-run last narrator output",
      });
      expect(result.manifest.rpc?.cancel).toEqual({
        handler: "./rpc/cancel.js",
        trustLevel: "builtin",
      });
    });

    it("skips malformed rpc block with warning and preserves other fields", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-bad-rpc",
          "description: Bad RPC",
          "stage: narrative",
          "rpc:",
          "  Bad-Name:", // uppercase rejected by schema
          "    handler: ./h.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-bad-rpc/PLUGIN.md");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain(
        "malformed rpc declaration skipped",
      );
      expect(result.manifest.rpc).toBeUndefined();
      expect(result.manifest.name).toBe("test-bad-rpc");
      warnSpy.mockRestore();
    });

    it("rejects rpc action names starting with framework-", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-reserved",
          "description: Reserved namespace",
          "stage: narrative",
          "rpc:",
          "  framework-cancel:",
          "    handler: ./h.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-reserved/PLUGIN.md");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it("rejects rpc handler with absolute path", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-abs-handler",
          "description: Absolute path attempt",
          "stage: narrative",
          "rpc:",
          "  do-thing:",
          "    handler: /etc/evil.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(
        content,
        "plugins/test-abs-handler/PLUGIN.md",
      );
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it("rejects rpc handler with parent-directory traversal", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-traversal",
          "description: Traversal attempt",
          "stage: narrative",
          "rpc:",
          "  do-thing:",
          "    handler: ../../../etc/evil.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-traversal/PLUGIN.md");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it("rejects rpc handler with mid-path .. segment", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-mid-traversal",
          "description: Mid traversal",
          "stage: narrative",
          "rpc:",
          "  do-thing:",
          "    handler: ./rpc/../../etc/evil.js",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(
        content,
        "plugins/test-mid-traversal/PLUGIN.md",
      );
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it("rejects rpc handler with non-js extension", () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const content = md(
        [
          "name: test-bad-ext",
          "description: Bad extension",
          "stage: narrative",
          "rpc:",
          "  do-thing:",
          "    handler: ./rpc/do-thing.ts",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-bad-ext/PLUGIN.md");
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it("accepts .mjs and .cjs extensions", () => {
      const content = md(
        [
          "name: test-ext-ok",
          "description: All extensions",
          "stage: narrative",
          "rpc:",
          "  esm:",
          "    handler: ./rpc/esm.mjs",
          "  cjs:",
          "    handler: ./rpc/cjs.cjs",
        ].join("\n"),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-ext-ok/PLUGIN.md");
      expect(result.manifest.rpc?.esm?.handler).toBe("./rpc/esm.mjs");
      expect(result.manifest.rpc?.cjs?.handler).toBe("./rpc/cjs.cjs");
    });

    it("omitting rpc field yields undefined", () => {
      const content = md(
        ["name: test-no-rpc", "description: No RPC", "stage: narrative"].join(
          "\n",
        ),
        "\nBody.\n",
      );
      const result = parsePluginMd(content, "plugins/test-no-rpc/PLUGIN.md");
      expect(result.manifest.rpc).toBeUndefined();
    });
  });

  describe("invalid name format", () => {
    it("should reject uppercase characters in name", () => {
      const content = md(
        ["name: CoreNarrator", "description: Bad name", "stage: pre-turn"].join(
          "\n",
        ),
        "\nBody.\n",
      );

      expect(() => parsePluginMd(content, "plugins/bad/PLUGIN.md")).toThrow();
    });

    it("should reject names with special characters", () => {
      const content = md(
        [
          "name: core_narrator",
          "description: Underscore name",
          "stage: pre-turn",
        ].join("\n"),
        "\nBody.\n",
      );

      expect(() => parsePluginMd(content, "plugins/bad/PLUGIN.md")).toThrow();
    });
  });

  describe("summaryFocus field", () => {
    it("parses summaryFocus as array of strings", () => {
      const content = md(
        [
          "name: narrator",
          "description: Main narrative",
          "stage: narrative",
          "summaryFocus:",
          "  - narrative",
          "  - character-state",
          "  - world-facts",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/narrator/PLUGIN.md");
      expect(result.manifest.summaryFocus).toEqual([
        "narrative",
        "character-state",
        "world-facts",
      ]);
    });

    it("summaryFocus is optional — omitting it yields undefined", () => {
      const content = md(
        [
          "name: narrator",
          "description: Main narrative",
          "stage: narrative",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/narrator/PLUGIN.md");
      expect(result.manifest.summaryFocus).toBeUndefined();
    });

    it("accepts empty summaryFocus array", () => {
      const content = md(
        [
          "name: narrator",
          "description: Main narrative",
          "stage: narrative",
          "summaryFocus: []",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/narrator/PLUGIN.md");
      expect(result.manifest.summaryFocus).toEqual([]);
    });
  });

  describe("framework-known capability registry", () => {
    it("collects both plugin-level and runtime-level framework capabilities", () => {
      // Plugin-level tags
      expect(FRAMEWORK_KNOWN_CAPABILITIES).toContain(
        FrameworkCapability.ImageGeneration,
      );
      expect(FRAMEWORK_KNOWN_CAPABILITIES).toContain(
        FrameworkCapability.WorldDataProvider,
      );
      // Runtime-level tags (the previously bare-string image pipeline)
      expect(FrameworkRuntimeCapability.ImagePrompt).toBe("image-prompt");
      expect(FrameworkRuntimeCapability.ImageGenerator).toBe("image-generator");
      expect(FRAMEWORK_KNOWN_CAPABILITIES).toContain(
        FrameworkRuntimeCapability.ImagePrompt,
      );
      expect(FRAMEWORK_KNOWN_CAPABILITIES).toContain(
        FrameworkRuntimeCapability.ImageGenerator,
      );
      // Registry is the union of both sets (no missing / extra entries)
      expect(new Set(FRAMEWORK_KNOWN_CAPABILITIES).size).toBe(
        Object.values(FrameworkCapability).length +
          Object.values(FrameworkRuntimeCapability).length,
      );
    });
  });

  describe("events declarations", () => {
    it("parses a valid events list with defaults", () => {
      const content = md(
        [
          "name: scene-consumer",
          "description: Reacts to scene events",
          "stage: narrative",
          "events:",
          "  - topic: scene.set",
          "    schema: ./schemas/scene-set.event.json",
          "    description:",
          "      zh: 场景切换",
          "      en: Scene change",
        ].join("\n"),
        "\nBody.\n",
      );

      const result = parsePluginMd(content, "plugins/scene-consumer/PLUGIN.md");

      expect(result.manifest.events).toEqual([
        {
          topic: "scene.set",
          schema: "./schemas/scene-set.event.json",
          description: { zh: "场景切换", en: "Scene change" },
          advertise: true,
        },
      ]);
    });

    it("rejects an invalid topic format", () => {
      const content = md(
        [
          "name: scene-consumer",
          "description: Reacts to scene events",
          "stage: narrative",
          "events:",
          "  - topic: SceneSet",
          "    schema: ./schemas/scene-set.event.json",
          "    description: Scene change",
        ].join("\n"),
        "\nBody.\n",
      );

      expect(() =>
        parsePluginMd(content, "plugins/scene-consumer/PLUGIN.md"),
      ).toThrow(/topic/);
    });

    it("rejects schema path escaping the plugin dir", () => {
      const content = md(
        [
          "name: scene-consumer",
          "description: Reacts to scene events",
          "stage: narrative",
          "events:",
          "  - topic: scene.set",
          "    schema: ../outside.json",
          "    description: Scene change",
        ].join("\n"),
        "\nBody.\n",
      );

      expect(() =>
        parsePluginMd(content, "plugins/scene-consumer/PLUGIN.md"),
      ).toThrow(/schema/);
    });

    it("parses runtime-level advertiseEvents boolean", () => {
      const withFlag = md(
        [
          "name: narrator",
          "description: Main narrative generation",
          "stage: narrative",
          "advertiseEvents: true",
        ].join("\n"),
        "\nBody.\n",
      );
      const resultWithFlag = parsePluginMd(
        withFlag,
        "plugins/narrator/PLUGIN.md",
      );
      expect(resultWithFlag.manifest.advertiseEvents).toBe(true);

      const withoutFlag = md(
        [
          "name: narrator",
          "description: Main narrative generation",
          "stage: narrative",
        ].join("\n"),
        "\nBody.\n",
      );
      const resultWithoutFlag = parsePluginMd(
        withoutFlag,
        "plugins/narrator/PLUGIN.md",
      );
      expect(resultWithoutFlag.manifest.advertiseEvents).toBeUndefined();
    });
  });
});
