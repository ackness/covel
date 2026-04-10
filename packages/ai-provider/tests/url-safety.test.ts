/**
 * Tests for SSRF protection in provider URL validation.
 */
import { describe, it, expect } from 'vitest';
import { validateBaseUrl, buildProviderUrl } from '../src/adapters/http.js';

describe('validateBaseUrl', () => {
  describe('allowed URLs', () => {
    it('allows known provider domains', () => {
      expect(validateBaseUrl('https://api.openai.com')).toBe(true);
      expect(validateBaseUrl('https://api.anthropic.com')).toBe(true);
      expect(validateBaseUrl('https://api.deepseek.com')).toBe(true);
      expect(validateBaseUrl('https://dashscope.aliyuncs.com')).toBe(true);
      expect(validateBaseUrl('https://openrouter.ai')).toBe(true);
    });

    it('allows localhost for development', () => {
      expect(validateBaseUrl('http://localhost:11434')).toBe(true);
      expect(validateBaseUrl('http://127.0.0.1:8080')).toBe(true);
      expect(validateBaseUrl('http://localhost:3000/v1')).toBe(true);
    });

    it('allows subdomains of known providers', () => {
      expect(validateBaseUrl('https://models.api.openai.com')).toBe(true);
      expect(validateBaseUrl('https://eu.api.anthropic.com')).toBe(true);
    });
  });

  describe('blocked URLs', () => {
    it('blocks cloud metadata endpoints', () => {
      expect(validateBaseUrl('http://169.254.169.254/latest/meta-data/')).toBe(false);
      expect(validateBaseUrl('http://metadata.google.internal')).toBe(false);
    });

    it('blocks private network ranges (RFC1918)', () => {
      expect(validateBaseUrl('http://10.0.0.1:8080')).toBe(false);
      expect(validateBaseUrl('http://192.168.1.1')).toBe(false);
      expect(validateBaseUrl('http://172.16.0.1')).toBe(false);
    });

    it('blocks link-local addresses', () => {
      expect(validateBaseUrl('http://169.254.1.1')).toBe(false);
    });

    it('blocks unknown external domains', () => {
      expect(validateBaseUrl('https://evil.com/proxy')).toBe(false);
      expect(validateBaseUrl('http://internal-db:5432')).toBe(false);
    });

    it('blocks empty or malformed URLs', () => {
      expect(validateBaseUrl('')).toBe(false);
      expect(validateBaseUrl('not-a-url')).toBe(false);
      expect(validateBaseUrl('ftp://files.example.com')).toBe(false);
    });
  });

  describe('custom allowed hosts via env', () => {
    it('allows hosts specified in COVEL_ALLOWED_LLM_HOSTS', () => {
      const original = process.env.COVEL_ALLOWED_LLM_HOSTS;
      try {
        process.env.COVEL_ALLOWED_LLM_HOSTS = 'my-llm.internal.corp,custom-ai.example.com';
        expect(validateBaseUrl('https://my-llm.internal.corp/v1')).toBe(true);
        expect(validateBaseUrl('https://custom-ai.example.com')).toBe(true);
        expect(validateBaseUrl('https://still-blocked.com')).toBe(false);
      } finally {
        if (original === undefined) delete process.env.COVEL_ALLOWED_LLM_HOSTS;
        else process.env.COVEL_ALLOWED_LLM_HOSTS = original;
      }
    });
  });
});

describe('buildProviderUrl', () => {
  it('builds URL from base and path', () => {
    expect(buildProviderUrl('https://api.openai.com', '/v1/chat/completions'))
      .toBe('https://api.openai.com/v1/chat/completions');
  });

  it('handles trailing slash in base', () => {
    expect(buildProviderUrl('https://api.openai.com/', 'v1/chat'))
      .toBe('https://api.openai.com/v1/chat');
  });
});
