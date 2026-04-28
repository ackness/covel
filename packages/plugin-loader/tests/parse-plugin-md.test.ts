import { describe, it, expect, vi } from 'vitest';
import { parsePluginMd } from '../src/parse-plugin-md.js';

// ── Helpers ──────────────────────────────────────────────────────

function md(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n${body}`;
}

// ── Tests ────────────────────────────────────────────────────────

describe('parsePluginMd', () => {
  describe('minimal PLUGIN.md', () => {
    it('should parse name, description, priority and body', () => {
      const content = md(
        [
          'name: narrator',
          'description: Main narrative generation',
          'priority: 400',
        ].join('\n'),
        '\nYou are the narrator of an RPG story.\n',
      );

      const result = parsePluginMd(content, 'plugins/narrator/PLUGIN.md');

      expect(result.manifest.name).toBe('narrator');
      expect(result.manifest.description).toBe('Main narrative generation');
      expect(result.manifest.priority).toBe(400);
      expect(result.promptTemplate).toBe(
        '\nYou are the narrator of an RPG story.\n',
      );
      expect(result.referenceLinks).toEqual([]);
      expect(result.rawFrontmatter).toEqual({
        name: 'narrator',
        description: 'Main narrative generation',
        priority: 400,
      });
    });
  });

  describe('full frontmatter', () => {
    it('should parse all optional fields', () => {
      const content = md(
        [
          'name: combat',
          'description: Structured turn-based combat',
          'priority: 420',
          'version: "1.0.0"',
          'model: balance',
          'trigger:',
          '  type: event',
          '  topic: combat-start',
          'tools:',
          '  builtin:',
          '    - state.get',
          '    - state.patch',
          '  local:',
          '    - roll-dice',
          'input:',
          '  inject:',
          '    - from: narrator',
          '      field: narrativeOutput',
          '      as: narrativeContext',
          'output:',
          '  schema: combat-result',
          '  recordAs: combat-log',
          'config:',
          '  difficulty:',
          '    type: enum',
          '    default: normal',
          '    options:',
          '      - easy',
          '      - normal',
          '      - hard',
          '    label: Difficulty',
          '    description: Combat difficulty level',
        ].join('\n'),
        '\nHandle combat encounters.\n',
      );

      const result = parsePluginMd(content, 'plugins/combat/PLUGIN.md');

      expect(result.manifest.name).toBe('combat');
      expect(result.manifest.version).toBe('1.0.0');
      expect(result.manifest.model).toBe('balance');
      expect(result.manifest.trigger).toEqual({
        type: 'event',
        topic: 'combat-start',
      });
      expect(result.manifest.tools).toEqual({
        builtin: ['state.get', 'state.patch'],
        local: ['roll-dice'],
      });
      expect(result.manifest.input).toEqual({
        inject: [
          {
            // Legacy shape auto-normalised by schema preprocess.
            kind: 'runtime',
            from: 'narrator',
            field: 'narrativeOutput',
            as: 'narrativeContext',
          },
        ],
      });
      expect(result.manifest.output).toEqual({
        schema: 'combat-result',
        recordAs: 'combat-log',
      });
      expect(result.manifest.config).toEqual({
        difficulty: {
          type: 'enum',
          default: 'normal',
          options: ['easy', 'normal', 'hard'],
          label: 'Difficulty',
          description: 'Combat difficulty level',
        },
      });
    });
  });

  describe('input.inject — plugin-data source', () => {
    it('parses a plugin-data inject with explicit format and maxEntries', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 650',
          'input:',
          '  inject:',
          '    - kind: plugin-data',
          '      namespace: entries',
          '      as: "<existing-entries>"',
          '      format: summary',
          '      maxEntries: 100',
        ].join('\n'),
        '\ncodex body\n',
      );

      const result = parsePluginMd(content, 'plugins/codex/PLUGIN.md');

      expect(result.manifest.input).toEqual({
        inject: [
          {
            kind: 'plugin-data',
            namespace: 'entries',
            as: '<existing-entries>',
            format: 'summary',
            maxEntries: 100,
          },
        ],
      });
    });

    it('fills plugin-data defaults when format / maxEntries omitted', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 650',
          'input:',
          '  inject:',
          '    - kind: plugin-data',
          '      namespace: entries',
          '      as: "<existing-entries>"',
        ].join('\n'),
        '\ncodex body\n',
      );

      const result = parsePluginMd(content, 'plugins/codex/PLUGIN.md');

      expect(result.manifest.input?.inject?.[0]).toEqual({
        kind: 'plugin-data',
        namespace: 'entries',
        as: '<existing-entries>',
        format: 'summary',
        maxEntries: 50,
      });
    });

    it('allows mixing runtime + plugin-data injects in one list', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 650',
          'input:',
          '  inject:',
          '    - from: narrator',
          '      field: narrativeOutput',
          '      as: "<narrator-output>"',
          '    - kind: plugin-data',
          '      namespace: entries',
          '      as: "<existing-entries>"',
          '      format: ids-only',
          '      maxEntries: 20',
        ].join('\n'),
        '\ncodex body\n',
      );

      const result = parsePluginMd(content, 'plugins/codex/PLUGIN.md');
      const injects = result.manifest.input?.inject ?? [];
      expect(injects).toHaveLength(2);
      expect(injects[0]).toMatchObject({
        kind: 'runtime',
        from: 'narrator',
        field: 'narrativeOutput',
      });
      expect(injects[1]).toMatchObject({
        kind: 'plugin-data',
        namespace: 'entries',
        format: 'ids-only',
        maxEntries: 20,
      });
    });

    it('rejects maxEntries outside [1, 500]', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 650',
          'input:',
          '  inject:',
          '    - kind: plugin-data',
          '      namespace: entries',
          '      as: "<existing-entries>"',
          '      maxEntries: 9999',
        ].join('\n'),
        '\nbody\n',
      );
      expect(() =>
        parsePluginMd(content, 'plugins/codex/PLUGIN.md'),
      ).toThrow();
    });

    it('rejects invalid namespace characters', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 650',
          'input:',
          '  inject:',
          '    - kind: plugin-data',
          '      namespace: "invalid namespace with spaces"',
          '      as: "<existing-entries>"',
        ].join('\n'),
        '\nbody\n',
      );
      expect(() =>
        parsePluginMd(content, 'plugins/codex/PLUGIN.md'),
      ).toThrow();
    });
  });

  describe('reference links extraction', () => {
    it('should extract references/xxx.md links from body', () => {
      const content = md(
        [
          'name: codex',
          'description: Knowledge codex',
          'priority: 700',
        ].join('\n'),
        [
          '',
          'You manage the knowledge codex.',
          '',
          'See [combat rules](references/combat-rules.md) for details.',
          'Also check [lore database](references/lore-db.md).',
          'But ignore [external link](https://example.com).',
          '',
        ].join('\n'),
      );

      const result = parsePluginMd(content, 'plugins/codex/PLUGIN.md');

      expect(result.referenceLinks).toEqual([
        'references/combat-rules.md',
        'references/lore-db.md',
      ]);
    });
  });

  describe('template variables', () => {
    it('should preserve template variables as-is', () => {
      const body = [
        '',
        '## Context',
        '',
        '{{ inputs.narrator.main.narrativeOutput }}',
        '',
        'Continue the story based on the above.',
        '',
      ].join('\n');

      const content = md(
        [
          'name: guide',
          'description: Story guidance',
          'priority: 600',
        ].join('\n'),
        body,
      );

      const result = parsePluginMd(content, 'plugins/guide/PLUGIN.md');

      expect(result.promptTemplate).toContain(
        '{{ inputs.narrator.main.narrativeOutput }}',
      );
    });
  });

  describe('invalid frontmatter', () => {
    it('should throw when required fields are missing', () => {
      // description is required but missing
      const content = md(
        ['name: core-test'].join('\n'),
        '\nBody text.\n',
      );

      expect(() =>
        parsePluginMd(content, 'plugins/core-test/PLUGIN.md'),
      ).toThrow();
    });

    it('should include file path in error message', () => {
      const content = md('name: core-test', '\nBody.\n');

      expect(() =>
        parsePluginMd(content, 'plugins/core-test/PLUGIN.md'),
      ).toThrow(/core-test/);
    });
  });

  describe('diagnostic error messages (D-4)', () => {
    it('error contains [plugin-loader] prefix, plugin path and a Fix: hint', () => {
      // Missing `description` — a required field.
      const content = md(
        ['name: core-needs-desc', 'priority: 400'].join('\n'),
        '\nBody.\n',
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, 'plugins/core-needs-desc/PLUGIN.md');
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toContain('[plugin-loader]');
      expect(caught!.message).toContain('plugins/core-needs-desc/PLUGIN.md');
      expect(caught!.message).toContain('Fix:');
      // Authoring-facing hint for the specific missing field.
      expect(caught!.message.toLowerCase()).toContain('description');
    });

    it('error for bad `name` format points at the name field with a kebab-case Fix hint', () => {
      const content = md(
        [
          'name: BadName',
          'description: Invalid name shape',
          'priority: 400',
        ].join('\n'),
        '\nBody.\n',
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, 'plugins/bad-name/PLUGIN.md');
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/\[plugin-loader\].*plugins\/bad-name\/PLUGIN\.md/);
      expect(caught!.message).toContain('Fix:');
      // The tailored hint for bad `name` mentions kebab-case.
      expect(caught!.message.toLowerCase()).toContain('kebab-case');
    });

    it('includes a 1-based line number when the failing key appears in source', () => {
      const content = md(
        [
          'name: core-line',
          'description: Line test',
          // priority must be an integer — pass a string to force a Zod error.
          'priority: "not-a-number"',
        ].join('\n'),
        '\nBody.\n',
      );

      let caught: Error | undefined;
      try {
        parsePluginMd(content, 'plugins/core-line/PLUGIN.md');
      } catch (err) {
        caught = err as Error;
      }

      expect(caught).toBeDefined();
      // `priority:` is the 4th line of the document (1: ---, 2: name, 3: description, 4: priority).
      expect(caught!.message).toMatch(/plugins\/core-line\/PLUGIN\.md:4:/);
      expect(caught!.message).toContain('Fix:');
    });
  });

  describe('empty body', () => {
    it('should return empty string for promptTemplate', () => {
      const content = md(
        [
          'name: core-empty',
          'description: Empty body plugin',
          'priority: 500',
        ].join('\n'),
        '',
      );

      const result = parsePluginMd(content, 'plugins/core-empty/PLUGIN.md');

      expect(result.promptTemplate).toBe('');
      expect(result.manifest.name).toBe('core-empty');
    });
  });

  describe('timeoutMs: runtime field', () => {
    it('parses a valid runtime timeout override', () => {
      const content = md(
        [
          'name: test-slow-runtime',
          'description: Runtime with custom timeout',
          'priority: 500',
          'timeoutMs: 180000',
        ].join('\n'),
        '\nBody text.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-slow-runtime/PLUGIN.md');

      expect(result.manifest.timeoutMs).toBe(180000);
    });
  });

  describe('hooks: field (S4-T3)', () => {
    it('parses a valid hooks declaration with all optional fields', () => {
      const content = md(
        [
          'name: test-guard-plugin',
          'description: Plugin with hooks',
          'priority: 500',
          'hookManifestVersion: 1',
          'hooks:',
          '  - event: PreToolUse',
          '    handler: ./hooks/validate.ts',
          '    timeoutMs: 3000',
          '    enforce: pre',
          '    match:',
          '      tool: create-character',
          '  - event: PostStateCommit',
          '    handler: ./hooks/audit.ts',
        ].join('\n'),
        '\nGuard plugin body.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-guard-plugin/PLUGIN.md');

      expect(result.manifest.hooks).toHaveLength(2);
      expect(result.manifest.hooks![0]).toMatchObject({
        event: 'PreToolUse',
        handler: './hooks/validate.ts',
        timeoutMs: 3000,
        enforce: 'pre',
        match: { tool: 'create-character' },
      });
      expect(result.manifest.hooks![1]).toMatchObject({
        event: 'PostStateCommit',
        handler: './hooks/audit.ts',
      });
    });

    it('parses all 8 valid hook event names', () => {
      const validEvents = [
        'TurnStart', 'PreRuntime', 'PostRuntime',
        'PreToolUse', 'PostToolUse',
        'PreStateCommit', 'PostStateCommit', 'TurnStop',
      ];

      for (const event of validEvents) {
        const content = md(
          [
            'name: test-hook-plugin',
            'description: Hook event test',
            'priority: 500',
            'hookManifestVersion: 1',
            'hooks:',
            `  - event: ${event}`,
            '    handler: ./hooks/handler.ts',
          ].join('\n'),
          '\nBody.\n',
        );

        const result = parsePluginMd(content, 'plugins/test-hook-plugin/PLUGIN.md');
        expect(result.manifest.hooks![0].event).toBe(event);
      }
    });

    it('skips invalid hook event with warning and returns only valid entries', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-bad-hook',
          'description: Bad hook event',
          'priority: 500',
          'hookManifestVersion: 1',
          'hooks:',
          '  - event: InvalidEvent',
          '    handler: ./hooks/bad.ts',
          '  - event: PreToolUse',
          '    handler: ./hooks/good.ts',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-bad-hook/PLUGIN.md');

      // Warning emitted for the invalid event
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('InvalidEvent');
      expect(warnSpy.mock.calls[0][0]).toContain('plugins/test-bad-hook/PLUGIN.md');

      // Only the valid entry survives
      expect(result.manifest.hooks).toHaveLength(1);
      expect(result.manifest.hooks![0].event).toBe('PreToolUse');

      warnSpy.mockRestore();
    });

    it('returns hooks: undefined when all hook entries have invalid events', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-all-bad-hooks',
          'description: All bad hook events',
          'priority: 500',
          'hooks:',
          '  - event: Bogus',
          '    handler: ./hooks/bad.ts',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-all-bad-hooks/PLUGIN.md');

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.hooks).toBeUndefined();

      warnSpy.mockRestore();
    });

    it('skips malformed hook entry with warning and keeps valid siblings (review I1)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-malformed-hook',
          'description: Mix of valid + malformed entries',
          'priority: 500',
          'hookManifestVersion: 1',
          'hooks:',
          '  - event: PreToolUse',
          '    handler: ./hooks/ok.ts',
          '  - event: PreToolUse',
          '    handler: 42',  // numeric handler — invalid type
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-malformed-hook/PLUGIN.md');

      expect(warnSpy).toHaveBeenCalledOnce();
      const warnMsg = warnSpy.mock.calls[0][0] as string;
      expect(warnMsg).toContain('malformed hook entry skipped');
      expect(result.manifest.hooks).toHaveLength(1);
      expect(result.manifest.hooks![0].handler).toBe('./hooks/ok.ts');

      warnSpy.mockRestore();
    });

    it('skips hooks until hookManifestVersion is declared', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-ungated-hooks',
          'description: Hooks without gate',
          'priority: 500',
          'hooks:',
          '  - event: PreToolUse',
          '    handler: ./hooks/ok.ts',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-ungated-hooks/PLUGIN.md');

      expect(result.manifest.hooks).toBeUndefined();
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('hookManifestVersion: 1');

      warnSpy.mockRestore();
    });

    it('parses plugin without hooks field (optional)', () => {
      const content = md(
        [
          'name: no-hooks-plugin',
          'description: Plugin without hooks',
          'priority: 500',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/no-hooks-plugin/PLUGIN.md');
      expect(result.manifest.hooks).toBeUndefined();
    });
  });

  describe("authorsNote field (S3-T4)", () => {
    it('parses a minimal authorsNote declaration', () => {
      const content = md(
        [
          'name: test-note',
          'description: Author note plugin',
          'priority: 500',
          'authorsNote:',
          '  content: Stay in character and keep pacing tight.',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-note/PLUGIN.md');
      expect(result.manifest.authorsNote).toEqual({
        content: 'Stay in character and keep pacing tight.',
      });
    });

    it('parses authorsNote with depth and role', () => {
      const content = md(
        [
          'name: test-note',
          'description: Full note',
          'priority: 500',
          'authorsNote:',
          '  content: Director note body',
          '  depth: 2',
          '  role: user',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-note/PLUGIN.md');
      expect(result.manifest.authorsNote).toEqual({
        content: 'Director note body',
        depth: 2,
        role: 'user',
      });
    });

    it('skips malformed authorsNote with warning and preserves other fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-bad-note',
          'description: Bad note shape',
          'priority: 500',
          'authorsNote:',
          '  content: "valid"',
          '  depth: not-a-number',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-bad-note/PLUGIN.md');

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('malformed authorsNote skipped');
      expect(result.manifest.authorsNote).toBeUndefined();
      // Other fields still parsed correctly
      expect(result.manifest.name).toBe('test-bad-note');
      expect(result.manifest.priority).toBe(500);

      warnSpy.mockRestore();
    });

    it('rejects authorsNote with unknown role', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-bad-role',
          'description: Unknown role',
          'priority: 500',
          'authorsNote:',
          '  content: "valid content"',
          '  role: tool',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-bad-role/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.authorsNote).toBeUndefined();
      warnSpy.mockRestore();
    });
  });

  describe("postHistory field (S3-T4)", () => {
    it('parses a minimal postHistory declaration', () => {
      const content = md(
        [
          'name: test-post',
          'description: Post history plugin',
          'priority: 500',
          'postHistory:',
          '  content: Always respond in markdown.',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-post/PLUGIN.md');
      expect(result.manifest.postHistory).toEqual({
        content: 'Always respond in markdown.',
      });
    });

    it('parses postHistory with role override', () => {
      const content = md(
        [
          'name: test-post',
          'description: Full post',
          'priority: 500',
          'postHistory:',
          '  content: Final instructions',
          '  role: user',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-post/PLUGIN.md');
      expect(result.manifest.postHistory).toEqual({
        content: 'Final instructions',
        role: 'user',
      });
    });

    it('skips malformed postHistory with warning and preserves other fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const content = md(
        [
          'name: test-bad-post',
          'description: Bad shape',
          'priority: 500',
          'postHistory:',
          '  content: 42',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-bad-post/PLUGIN.md');

      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('malformed postHistory skipped');
      expect(result.manifest.postHistory).toBeUndefined();
      expect(result.manifest.name).toBe('test-bad-post');

      warnSpy.mockRestore();
    });

    it('parses both authorsNote and postHistory together', () => {
      const content = md(
        [
          'name: test-both',
          'description: Both fields',
          'priority: 500',
          'authorsNote:',
          '  content: Director',
          '  depth: 3',
          'postHistory:',
          '  content: Final',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-both/PLUGIN.md');
      expect(result.manifest.authorsNote?.content).toBe('Director');
      expect(result.manifest.authorsNote?.depth).toBe(3);
      expect(result.manifest.postHistory?.content).toBe('Final');
    });

    it('omitting both fields yields undefined', () => {
      const content = md(
        [
          'name: test-none',
          'description: No note fields',
          'priority: 500',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/test-none/PLUGIN.md');
      expect(result.manifest.authorsNote).toBeUndefined();
      expect(result.manifest.postHistory).toBeUndefined();
    });
  });

  describe('rpc field (PR-3)', () => {
    it('parses a single rpc action declaration', () => {
      const content = md(
        [
          'name: test-rpc',
          'description: RPC plugin',
          'priority: 500',
          'rpc:',
          '  regenerate:',
          '    handler: ./rpc/regenerate.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-rpc/PLUGIN.md');
      expect(result.manifest.rpc).toEqual({
        regenerate: { handler: './rpc/regenerate.js' },
      });
    });

    it('parses multiple rpc actions with full options', () => {
      const content = md(
        [
          'name: test-rpc-full',
          'description: Full RPC plugin',
          'priority: 500',
          'rpc:',
          '  regenerate:',
          '    handler: ./rpc/regenerate.js',
          '    streaming: true',
          '    description: Re-run last narrator output',
          '  cancel:',
          '    handler: ./rpc/cancel.js',
          '    trustLevel: builtin',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-rpc-full/PLUGIN.md');
      expect(result.manifest.rpc?.regenerate).toEqual({
        handler: './rpc/regenerate.js',
        streaming: true,
        description: 'Re-run last narrator output',
      });
      expect(result.manifest.rpc?.cancel).toEqual({
        handler: './rpc/cancel.js',
        trustLevel: 'builtin',
      });
    });

    it('skips malformed rpc block with warning and preserves other fields', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-bad-rpc',
          'description: Bad RPC',
          'priority: 500',
          'rpc:',
          '  Bad-Name:', // uppercase rejected by schema
          '    handler: ./h.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-bad-rpc/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0][0]).toContain('malformed rpc declaration skipped');
      expect(result.manifest.rpc).toBeUndefined();
      expect(result.manifest.name).toBe('test-bad-rpc');
      warnSpy.mockRestore();
    });

    it('rejects rpc action names starting with framework-', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-reserved',
          'description: Reserved namespace',
          'priority: 500',
          'rpc:',
          '  framework-cancel:',
          '    handler: ./h.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-reserved/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('rejects rpc handler with absolute path (HIGH-1 fix)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-abs-handler',
          'description: Absolute path attempt',
          'priority: 500',
          'rpc:',
          '  do-thing:',
          '    handler: /etc/evil.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-abs-handler/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('rejects rpc handler with parent-directory traversal (HIGH-1 fix)', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-traversal',
          'description: Traversal attempt',
          'priority: 500',
          'rpc:',
          '  do-thing:',
          '    handler: ../../../etc/evil.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-traversal/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('rejects rpc handler with mid-path .. segment', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-mid-traversal',
          'description: Mid traversal',
          'priority: 500',
          'rpc:',
          '  do-thing:',
          '    handler: ./rpc/../../etc/evil.js',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-mid-traversal/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('rejects rpc handler with non-js extension', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const content = md(
        [
          'name: test-bad-ext',
          'description: Bad extension',
          'priority: 500',
          'rpc:',
          '  do-thing:',
          '    handler: ./rpc/do-thing.ts',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-bad-ext/PLUGIN.md');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(result.manifest.rpc).toBeUndefined();
      warnSpy.mockRestore();
    });

    it('accepts .mjs and .cjs extensions', () => {
      const content = md(
        [
          'name: test-ext-ok',
          'description: All extensions',
          'priority: 500',
          'rpc:',
          '  esm:',
          '    handler: ./rpc/esm.mjs',
          '  cjs:',
          '    handler: ./rpc/cjs.cjs',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-ext-ok/PLUGIN.md');
      expect(result.manifest.rpc?.esm?.handler).toBe('./rpc/esm.mjs');
      expect(result.manifest.rpc?.cjs?.handler).toBe('./rpc/cjs.cjs');
    });

    it('omitting rpc field yields undefined', () => {
      const content = md(
        [
          'name: test-no-rpc',
          'description: No RPC',
          'priority: 500',
        ].join('\n'),
        '\nBody.\n',
      );
      const result = parsePluginMd(content, 'plugins/test-no-rpc/PLUGIN.md');
      expect(result.manifest.rpc).toBeUndefined();
    });
  });

  describe('invalid name format', () => {
    it('should reject uppercase characters in name', () => {
      const content = md(
        [
          'name: CoreNarrator',
          'description: Bad name',
          'priority: 400',
        ].join('\n'),
        '\nBody.\n',
      );

      expect(() =>
        parsePluginMd(content, 'plugins/bad/PLUGIN.md'),
      ).toThrow();
    });

    it('should reject names with special characters', () => {
      const content = md(
        [
          'name: core_narrator',
          'description: Underscore name',
          'priority: 400',
        ].join('\n'),
        '\nBody.\n',
      );

      expect(() =>
        parsePluginMd(content, 'plugins/bad/PLUGIN.md'),
      ).toThrow();
    });
  });

  describe('summaryFocus field (S2-T2)', () => {
    it('parses summaryFocus as array of strings', () => {
      const content = md(
        [
          'name: narrator',
          'description: Main narrative',
          'priority: 500',
          'summaryFocus:',
          '  - narrative',
          '  - character-state',
          '  - world-facts',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/narrator/PLUGIN.md');
      expect(result.manifest.summaryFocus).toEqual(['narrative', 'character-state', 'world-facts']);
    });

    it('summaryFocus is optional — omitting it yields undefined', () => {
      const content = md(
        [
          'name: narrator',
          'description: Main narrative',
          'priority: 500',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/narrator/PLUGIN.md');
      expect(result.manifest.summaryFocus).toBeUndefined();
    });

    it('accepts empty summaryFocus array', () => {
      const content = md(
        [
          'name: narrator',
          'description: Main narrative',
          'priority: 500',
          'summaryFocus: []',
        ].join('\n'),
        '\nBody.\n',
      );

      const result = parsePluginMd(content, 'plugins/narrator/PLUGIN.md');
      expect(result.manifest.summaryFocus).toEqual([]);
    });
  });
});
