import { describe, expect, it, vi } from 'vitest';
import {
  createPluginRpcRegistry,
  createRpcExecutor,
  RpcDispatchError,
} from '../src/index.js';
import type { RpcHandler } from '../src/index.js';

describe('PluginRpcRegistry (PR-3)', () => {
  it('registers a plugin action and looks it up by (pluginId, action)', () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginAction(
      'core-codex',
      'regenerate',
      { handler: './rpc/regenerate.js' },
      'official',
    );
    const entry = registry.getPluginAction('core-codex', 'regenerate');
    expect(entry).toBeDefined();
    expect(entry?.action).toBe('regenerate');
    expect(entry?.pluginId).toBe('core-codex');
    expect(entry?.trustLevel).toBe('official');
    expect(entry?.handlerPath).toBe('./rpc/regenerate.js');
  });

  it('honors per-action trust override when it is more restrictive than plugin source', () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginAction(
      'core-plugin',
      'risky-action',
      { handler: './h.js', trustLevel: 'community' },
      'builtin',
    );
    const entry = registry.getPluginAction('core-plugin', 'risky-action');
    expect(entry?.trustLevel).toBe('community');
  });

  it('clamps trust escalation to plugin source (CRITICAL-1 fix)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createPluginRpcRegistry();
    // A community plugin tries to opt itself into builtin trust → clamped.
    registry.registerPluginAction(
      'untrusted-plugin',
      'sneaky-action',
      { handler: './h.js', trustLevel: 'builtin' },
      'community',
    );
    const entry = registry.getPluginAction('untrusted-plugin', 'sneaky-action');
    expect(entry?.trustLevel).toBe('community');
    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy.mock.calls[0][0]).toContain('clamping to community');
    warnSpy.mockRestore();
  });

  it('clamps community plugin trying to claim official trust', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const registry = createPluginRpcRegistry();
    registry.registerPluginAction(
      'untrusted-plugin',
      'medium-action',
      { handler: './h.js', trustLevel: 'official' },
      'community',
    );
    const entry = registry.getPluginAction('untrusted-plugin', 'medium-action');
    expect(entry?.trustLevel).toBe('community');
    warnSpy.mockRestore();
  });

  it('official plugin can downgrade an action to community', () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginAction(
      'official-plugin',
      'restricted',
      { handler: './h.js', trustLevel: 'community' },
      'official',
    );
    expect(registry.getPluginAction('official-plugin', 'restricted')?.trustLevel).toBe('community');
  });

  it('throws on duplicate (pluginId, action) registration', () => {
    const registry = createPluginRpcRegistry();
    registry.registerPluginAction(
      'p',
      'a',
      { handler: './h.js' },
      'official',
    );
    expect(() =>
      registry.registerPluginAction(
        'p',
        'a',
        { handler: './h2.js' },
        'official',
      ),
    ).toThrow(/duplicate registration/);
  });

  it('framework defaults are returned by getFrameworkDefault', () => {
    const registry = createPluginRpcRegistry();
    const handler: RpcHandler = async () => ({ ok: true });
    registry.registerFrameworkDefault('cancel', handler, {
      description: 'stop the current turn',
    });
    const entry = registry.getFrameworkDefault('cancel');
    expect(entry?.handler).toBe(handler);
    expect(entry?.trustLevel).toBe('builtin');
    expect(entry?.description).toBe('stop the current turn');
  });

  it('list() returns framework + plugin entries', () => {
    const registry = createPluginRpcRegistry();
    registry.registerFrameworkDefault('submit-form', async () => null);
    registry.registerPluginAction(
      'core-codex',
      'regenerate',
      { handler: './h.js' },
      'official',
    );
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map((e) => e.action)).toContain('submit-form');
    expect(list.map((e) => e.action)).toContain('regenerate');
  });
});

describe('createRpcExecutor (PR-3)', () => {
  function makeExecutor(opts?: { loadHandler?: () => Promise<RpcHandler> }) {
    const registry = createPluginRpcRegistry();
    const loadHandler = vi.fn(
      opts?.loadHandler ?? (async (): Promise<RpcHandler> => async () => 'loaded-result'),
    );
    const executor = createRpcExecutor({ registry, loadHandler });
    return { registry, executor, loadHandler };
  }

  it('dispatches a framework default action', async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault('submit-form', async (payload) => ({
      received: payload,
    }));

    const result = await executor.dispatch(
      { pluginId: 'framework', action: 'submit-form', payload: { x: 1 } },
      { sessionId: 'sess-1', store: {} as never },
    );
    expect(result.entry.action).toBe('submit-form');
    expect(result.result).toEqual({ received: { x: 1 } });
  });

  it('dispatches a plugin-declared action via lazy loader', async () => {
    const { registry, executor, loadHandler } = makeExecutor();
    registry.registerPluginAction(
      'core-codex',
      'regenerate',
      { handler: './rpc/regenerate.js' },
      'official',
    );

    const result = await executor.dispatch(
      { pluginId: 'core-codex', action: 'regenerate', payload: null },
      { sessionId: 'sess-1', store: {} as never },
    );
    expect(loadHandler).toHaveBeenCalledWith('core-codex', './rpc/regenerate.js');
    expect(result.result).toBe('loaded-result');
  });

  it('caches the loaded handler module across calls', async () => {
    const { registry, executor, loadHandler } = makeExecutor();
    registry.registerPluginAction(
      'core-codex',
      'regenerate',
      { handler: './rpc/regenerate.js' },
      'official',
    );

    await executor.dispatch(
      { pluginId: 'core-codex', action: 'regenerate', payload: null },
      { sessionId: 'sess-1', store: {} as never },
    );
    await executor.dispatch(
      { pluginId: 'core-codex', action: 'regenerate', payload: null },
      { sessionId: 'sess-1', store: {} as never },
    );
    expect(loadHandler).toHaveBeenCalledTimes(1);
  });

  it('plugin-declared action takes precedence over framework default of the same name', async () => {
    const { registry, executor } = makeExecutor({
      loadHandler: async () => async () => 'plugin-version',
    });
    registry.registerFrameworkDefault('submit-form', async () => 'framework-version');
    registry.registerPluginAction(
      'core-codex',
      'submit-form',
      { handler: './rpc/submit-form.js' },
      'official',
    );

    const result = await executor.dispatch(
      { pluginId: 'core-codex', action: 'submit-form', payload: null },
      { sessionId: 'sess-1', store: {} as never },
    );
    expect(result.result).toBe('plugin-version');
  });

  it('throws RpcDispatchError with code "unknown-action" when nothing is registered', async () => {
    const { executor } = makeExecutor();
    await expect(
      executor.dispatch(
        { pluginId: 'nope', action: 'nada', payload: null },
        { sessionId: 'sess-1', store: {} as never },
      ),
    ).rejects.toMatchObject({
      name: 'RpcDispatchError',
      code: 'unknown-action',
    });
  });

  it('wraps thrown handler errors as RpcDispatchError code "handler-threw"', async () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault('boom', async () => {
      throw new Error('boom');
    });
    await expect(
      executor.dispatch(
        { pluginId: 'framework', action: 'boom', payload: null },
        { sessionId: 'sess-1', store: {} as never },
      ),
    ).rejects.toMatchObject({
      name: 'RpcDispatchError',
      code: 'handler-threw',
    });
  });

  it('handler-load failure surfaces as code "handler-load-failed"', async () => {
    const { registry, executor } = makeExecutor({
      loadHandler: async () => {
        throw new Error('module not found');
      },
    });
    registry.registerPluginAction(
      'p',
      'a',
      { handler: './missing.js' },
      'official',
    );
    await expect(
      executor.dispatch(
        { pluginId: 'p', action: 'a', payload: null },
        { sessionId: 'sess-1', store: {} as never },
      ),
    ).rejects.toMatchObject({
      name: 'RpcDispatchError',
      code: 'handler-load-failed',
    });
  });

  it('lookupEntry exposes resolution without invoking the handler', () => {
    const { registry, executor } = makeExecutor();
    registry.registerFrameworkDefault('cancel', async () => null);
    const entry = executor.lookupEntry('framework', 'cancel');
    expect(entry.action).toBe('cancel');
  });

  it('RpcDispatchError preserves error semantics (instance check)', async () => {
    const { executor } = makeExecutor();
    try {
      await executor.dispatch(
        { pluginId: 'p', action: 'a', payload: null },
        { sessionId: 'sess-1', store: {} as never },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RpcDispatchError);
    }
  });
});
