import { describe, it, expect, afterEach } from 'vitest';
import { OpenAIProvider } from '../src/agent/providers/openai.js';
import { loadConfig } from '../src/config.js';
import { makeProvider, isPrivacySensitiveEndpoint } from '../src/agent/loop.js';
import { checkCredential } from '../src/commands/doctor.js';
import { tempFixtureRepo } from './helpers.js';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

// ---------------------------------------------------------------------------
// isPrivacySensitiveEndpoint — unit tests
// ---------------------------------------------------------------------------
describe('isPrivacySensitiveEndpoint', () => {
  it('returns false when no baseURL is set', () => {
    expect(isPrivacySensitiveEndpoint(undefined, 'gpt-5')).toBe(false);
  });

  it('returns true for Gemini generativelanguage endpoint', () => {
    expect(isPrivacySensitiveEndpoint('https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-2.0-flash')).toBe(true);
  });

  it('returns true for openrouter.ai', () => {
    expect(isPrivacySensitiveEndpoint('https://openrouter.ai/api/v1', 'mistral-7b')).toBe(true);
  });

  it('returns true when model name contains :free suffix', () => {
    expect(isPrivacySensitiveEndpoint('https://openrouter.ai/api/v1', 'mistral-7b:free')).toBe(true);
  });

  it('returns false for Groq endpoint', () => {
    expect(isPrivacySensitiveEndpoint('https://api.groq.com/openai/v1', 'llama-3.3-70b-versatile')).toBe(false);
  });

  it('returns false for local Ollama', () => {
    expect(isPrivacySensitiveEndpoint('http://localhost:11434/v1', 'qwen2.5-coder')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — constructor wires baseURL
// ---------------------------------------------------------------------------
describe('OpenAIProvider baseURL', () => {
  it('constructs without throwing when a baseURL and key are provided', () => {
    expect(() => new OpenAIProvider('llama-3.3-70b-versatile', 'gsk_test_key', 'https://api.groq.com/openai/v1')).not.toThrow();
  });

  it('throws a helpful error when the key is missing for a custom endpoint', () => {
    expect(() => new OpenAIProvider('llama-3.3-70b-versatile', undefined, 'https://api.groq.com/openai/v1')).toThrow(
      /COPPERHEAD_API_KEY_ENV/,
    );
  });

  it('throws when no baseURL and no key', () => {
    expect(() => new OpenAIProvider('gpt-5', undefined, undefined)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// loadConfig — round-trips the two new fields
// ---------------------------------------------------------------------------
describe('loadConfig round-trips openaiCompat fields', () => {
  it('returns both fields when present in config.json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const configDir = path.join(repo, '.copperhead');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({
          openaiCompatBaseUrl: 'https://api.groq.com/openai/v1',
          openaiCompatApiKeyEnv: 'GROQ_API_KEY',
        }),
        'utf8',
      );
      const cfg = await loadConfig(repo);
      expect(cfg.openaiCompatBaseUrl).toBe('https://api.groq.com/openai/v1');
      expect(cfg.openaiCompatApiKeyEnv).toBe('GROQ_API_KEY');
    } finally {
      await cleanup();
    }
  });

  it('omits both fields when absent from config.json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const cfg = await loadConfig(repo);
      expect(cfg.openaiCompatBaseUrl).toBeUndefined();
      expect(cfg.openaiCompatApiKeyEnv).toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// makeProvider — threads env-var overrides to OpenAIProvider
// ---------------------------------------------------------------------------
describe('makeProvider OpenAI-compatible routing', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    Object.assign(process.env, savedEnv);
  });

  it('resolves COPPERHEAD_BASE_URL and COPPERHEAD_API_KEY_ENV from env', async () => {
    process.env.COPPERHEAD_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.COPPERHEAD_API_KEY_ENV = 'GROQ_API_KEY';
    process.env.GROQ_API_KEY = 'gsk_test_key';
    delete process.env.OPENAI_API_KEY;

    const provider = await makeProvider('llama-3.3-70b-versatile', false, {});
    expect(provider.name).toBe('openai');
  });

  it('prefers env COPPERHEAD_BASE_URL over config openaiCompatBaseUrl', async () => {
    process.env.COPPERHEAD_BASE_URL = 'https://api.groq.com/openai/v1';
    process.env.GROQ_API_KEY = 'gsk_test_key';
    process.env.COPPERHEAD_API_KEY_ENV = 'GROQ_API_KEY';
    delete process.env.OPENAI_API_KEY;

    const provider = await makeProvider('llama-3.3-70b-versatile', false, {
      openaiCompatBaseUrl: 'https://api.cerebras.ai/v1',
      openaiCompatApiKeyEnv: 'CEREBRAS_API_KEY',
    });
    expect(provider.name).toBe('openai');
  });

  it('falls back to OPENAI_API_KEY when no custom config', async () => {
    process.env.OPENAI_API_KEY = 'sk-test-key';
    delete process.env.COPPERHEAD_BASE_URL;
    delete process.env.COPPERHEAD_API_KEY_ENV;

    const provider = await makeProvider('gpt-5', false, {});
    expect(provider.name).toBe('openai');
  });
});

// ---------------------------------------------------------------------------
// checkCredential — OpenAI-compatible endpoint awareness
// ---------------------------------------------------------------------------
describe('checkCredential OpenAI-compatible endpoint', () => {
  it('reports the configured key env-var name and endpoint in detail when key is set', () => {
    const check = checkCredential(
      'llama-3.3-70b-versatile',
      { GROQ_API_KEY: 'gsk_test' },
      { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' },
    );
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('GROQ_API_KEY');
    expect(check.detail).toContain('api.groq.com');
  });

  it('fails with hint pointing to the custom env-var when key is missing', () => {
    const check = checkCredential(
      'llama-3.3-70b-versatile',
      {},
      { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' },
    );
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('GROQ_API_KEY');
    expect(check.hint).toContain('GROQ_API_KEY');
  });

  it('defaults to OPENAI_API_KEY when no config provided', () => {
    const check = checkCredential('gpt-5', { OPENAI_API_KEY: 'sk-test' });
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('OPENAI_API_KEY');
  });
});
