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
          'name: core-narrator',
          'description: Main narrative generation',
          'priority: 400',
        ].join('\n'),
        '\nYou are the narrator of an RPG story.\n',
      );

      const result = parsePluginMd(content, 'plugins/core-narrator/PLUGIN.md');

      expect(result.manifest.name).toBe('core-narrator');
      expect(result.manifest.description).toBe('Main narrative generation');
      expect(result.manifest.priority).toBe(400);
      expect(result.promptTemplate).toBe(
        '\nYou are the narrator of an RPG story.\n',
      );
      expect(result.referenceLinks).toEqual([]);
      expect(result.rawFrontmatter).toEqual({
        name: 'core-narrator',
        description: 'Main narrative generation',
        priority: 400,
      });
    });
  });

  describe('full frontmatter', () => {
    it('should parse all optional fields', () => {
      const content = md(
        [
          'name: core-combat',
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
          '    - from: core-narrator',
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

      const result = parsePluginMd(content, 'plugins/core-combat/PLUGIN.md');

      expect(result.manifest.name).toBe('core-combat');
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
            from: 'core-narrator',
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

  describe('reference links extraction', () => {
    it('should extract references/xxx.md links from body', () => {
      const content = md(
        [
          'name: core-codex',
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

      const result = parsePluginMd(content, 'plugins/core-codex/PLUGIN.md');

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
          'name: core-guide',
          'description: Story guidance',
          'priority: 600',
        ].join('\n'),
        body,
      );

      const result = parsePluginMd(content, 'plugins/core-guide/PLUGIN.md');

      expect(result.promptTemplate).toContain(
        '{{ inputs.narrator.main.narrativeOutput }}',
      );
    });
  });

  describe('invalid frontmatter', () => {
    it('should throw when required fields are missing', () => {
      const content = md(
        ['name: core-test', 'description: Test plugin'].join('\n'),
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

  describe('hooks: field (S4-T3)', () => {
    it('parses a valid hooks declaration with all optional fields', () => {
      const content = md(
        [
          'name: test-guard-plugin',
          'description: Plugin with hooks',
          'priority: 500',
          'hooks:',
          '  - event: PreToolUse',
          '    handler: ./hooks/validate.ts',
          '    timeoutMs: 3000',
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
});
