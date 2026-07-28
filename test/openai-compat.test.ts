import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { OpenAIProvider } from '../src/agent/providers/openai.js';
import {
  DEFAULT_OPENAI_COMPAT_API_KEY_ENV,
  classifyPromptPrivacy,
  isLocalEndpoint,
  loadConfig,
  resolveCompatSettings,
  resolveModel,
  type CopperheadConfig,
  DEFAULTS,
} from '../src/config.js';
import { makeProvider, runAgentLoop } from '../src/agent/loop.js';
import { checkCredential, checkPromptPrivacy, runDoctor } from '../src/commands/doctor.js';
import { tempFixtureRepo } from './helpers.js';

const base: CopperheadConfig = { schematic: null, board: null, ...DEFAULTS };

// ---------------------------------------------------------------------------
// resolveModel — ambiguous-credential refusal
// ---------------------------------------------------------------------------
describe('resolveModel — ambiguous credentials', () => {
  it('refuses to guess when two or more credentials are present, naming both', () => {
    expect(() => resolveModel(undefined, base, { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' })).toThrow(
      /ambiguous: 2 credentials found \(OPENAI_API_KEY, ANTHROPIC_API_KEY\)/,
    );
  });

  it('--model, COPPERHEAD_MODEL, and config.model all still break the tie explicitly', () => {
    const env = { OPENAI_API_KEY: 'x', ANTHROPIC_API_KEY: 'y' };
    expect(resolveModel('claude', base, env)).toEqual({ model: 'claude', source: 'flag' });
    expect(resolveModel(undefined, base, { ...env, COPPERHEAD_MODEL: 'gpt-5' })).toEqual({
      model: 'gpt-5',
      source: 'env',
    });
    expect(resolveModel(undefined, { ...base, model: 'claude' }, env)).toEqual({
      model: 'claude',
      source: 'config',
    });
  });

  it('a single credential is still a safe, silent guess (unchanged behavior)', () => {
    expect(resolveModel(undefined, base, { OPENAI_API_KEY: 'x' })).toEqual({ model: 'gpt-5', source: 'openai-key' });
    expect(resolveModel(undefined, base, { ANTHROPIC_API_KEY: 'y' })).toEqual({
      model: 'claude',
      source: 'anthropic-key',
    });
  });
});

// ---------------------------------------------------------------------------
// resolveCompatSettings / isLocalEndpoint
// ---------------------------------------------------------------------------
describe('resolveCompatSettings', () => {
  it('defaults to OPENAI_API_KEY and no endpoint', () => {
    const s = resolveCompatSettings(base, {});
    expect(s.openaiCompatApiKeyEnv).toBe(DEFAULT_OPENAI_COMPAT_API_KEY_ENV);
    expect(s.openaiCompatBaseUrl).toBeUndefined();
  });

  it('reads both fields from config', () => {
    const cfg = { ...base, openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' };
    const s = resolveCompatSettings(cfg, {});
    expect(s.openaiCompatBaseUrl).toBe('https://api.groq.com/openai/v1');
    expect(s.openaiCompatApiKeyEnv).toBe('GROQ_API_KEY');
  });

  it('env overrides config, same direction as resolveModel', () => {
    const cfg = { ...base, openaiCompatBaseUrl: 'https://from-config/v1', openaiCompatApiKeyEnv: 'CONFIG_KEY' };
    const s = resolveCompatSettings(cfg, {
      COPPERHEAD_BASE_URL: 'https://from-env/v1',
      COPPERHEAD_API_KEY_ENV: 'ENV_KEY',
    });
    expect(s.openaiCompatBaseUrl).toBe('https://from-env/v1');
    expect(s.openaiCompatApiKeyEnv).toBe('ENV_KEY');
  });

  it('an env var set to the empty string falls through to config, not "" (the .env.example footgun)', () => {
    const cfg = { ...base, openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' };
    const s = resolveCompatSettings(cfg, { COPPERHEAD_BASE_URL: '', COPPERHEAD_API_KEY_ENV: '' });
    expect(s.openaiCompatBaseUrl).toBe('https://api.groq.com/openai/v1');
    expect(s.openaiCompatApiKeyEnv).toBe('GROQ_API_KEY');
  });

  it('loadConfig ignores a blank-but-present field rather than treating it as configured', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const dir = path.join(repo, '.copperhead');
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'config.json'), JSON.stringify({ openaiCompatBaseUrl: '   ', openaiCompatApiKeyEnv: '' }), 'utf8');
      const cfg = await loadConfig(repo);
      expect(cfg.openaiCompatBaseUrl).toBeUndefined();
      expect(resolveCompatSettings(cfg, {}).openaiCompatApiKeyEnv).toBe(DEFAULT_OPENAI_COMPAT_API_KEY_ENV);
    } finally {
      await cleanup();
    }
  });
});

describe('isLocalEndpoint', () => {
  it('recognizes loopback and .local hosts', () => {
    for (const u of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:8080/v1',
      'http://ollama.local/v1',
      'http://[::1]:11434/v1',
    ]) {
      expect(isLocalEndpoint(u), u).toBe(true);
    }
  });

  it('returns false for remote hosts, undefined, and unparseable URLs', () => {
    for (const u of ['https://api.groq.com/openai/v1', 'https://openrouter.ai/api/v1', undefined, 'not a url']) {
      expect(isLocalEndpoint(u), String(u)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// classifyPromptPrivacy — shared by loop.ts's run-start notice and doctor.ts
// ---------------------------------------------------------------------------
describe('classifyPromptPrivacy', () => {
  const groq = { openaiCompatApiKeyEnv: 'GROQ_API_KEY', openaiCompatBaseUrl: 'https://api.groq.com/openai/v1' };
  const gemini = { openaiCompatApiKeyEnv: 'GEMINI_API_KEY', openaiCompatBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai' };
  const openrouter = { openaiCompatApiKeyEnv: 'OPENROUTER_API_KEY', openaiCompatBaseUrl: 'https://openrouter.ai/api/v1' };

  it('does not apply to non-compat models regardless of settings passed', () => {
    expect(classifyPromptPrivacy('gpt-5', gemini)).toEqual({ kind: 'none' });
    expect(classifyPromptPrivacy('claude', gemini)).toEqual({ kind: 'none' });
  });

  it('flags a documented training-risk host as risk', () => {
    expect(classifyPromptPrivacy('compat:gemini-2.0-flash', gemini)).toEqual({
      kind: 'risk',
      host: 'generativelanguage.googleapis.com',
      reason: expect.stringMatching(/train/i),
    });
  });

  it('matches a training-risk host on a subdomain too', () => {
    const c = classifyPromptPrivacy('compat:gemini-2.0-flash', {
      ...gemini,
      openaiCompatBaseUrl: 'https://region-a.generativelanguage.googleapis.com/v1beta/openai',
    });
    expect(c.kind).toBe('risk');
  });

  it('OpenRouter warns only for a :free-suffixed model, not a paid one', () => {
    expect(classifyPromptPrivacy('compat:some-vendor/some-model:free', openrouter).kind).toBe('risk');
    expect(classifyPromptPrivacy('compat:anthropic/claude-3.5-sonnet', openrouter)).toEqual({
      kind: 'unknown',
      host: 'openrouter.ai',
    });
  });

  it('reports "unknown" (not "risk") for a host with no policy on record', () => {
    expect(classifyPromptPrivacy('compat:qwen', groq)).toEqual({ kind: 'unknown', host: 'api.groq.com' });
  });

  it('bypasses entirely for true loopback — nothing leaves the machine', () => {
    for (const openaiCompatBaseUrl of ['http://localhost:11434/v1', 'http://127.0.0.1:11434/v1', 'http://[::1]:11434/v1']) {
      expect(classifyPromptPrivacy('compat:phi3', { openaiCompatApiKeyEnv: 'X', openaiCompatBaseUrl })).toEqual({
        kind: 'none',
      });
    }
  });

  it('does NOT bypass a .local (LAN) host — that traffic leaves the machine', () => {
    const c = classifyPromptPrivacy('compat:phi3', {
      openaiCompatApiKeyEnv: 'X',
      openaiCompatBaseUrl: 'http://nas.local:11434/v1',
    });
    expect(c).toEqual({ kind: 'unknown', host: 'nas.local' });
  });

  it('an unparseable or unconfigured endpoint reports none rather than a wrong classification', () => {
    expect(classifyPromptPrivacy('compat:phi3', { openaiCompatApiKeyEnv: 'X', openaiCompatBaseUrl: 'not a url' })).toEqual({
      kind: 'none',
    });
    expect(classifyPromptPrivacy('compat:phi3', undefined)).toEqual({ kind: 'none' });
  });
});

// ---------------------------------------------------------------------------
// OpenAIProvider — compatible endpoints
// ---------------------------------------------------------------------------
describe('OpenAIProvider — compat endpoints', () => {
  const savedOpenAiKey = process.env.OPENAI_API_KEY;
  beforeEach(() => {
    delete process.env.OPENAI_API_KEY;
  });
  afterEach(() => {
    if (savedOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAiKey;
  });

  it('reads the key from the configured variable name, not always OPENAI_API_KEY', () => {
    const p = new OpenAIProvider(
      'llama-3.3-70b-versatile',
      { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' },
      { GROQ_API_KEY: 'gsk_test' },
    );
    expect(p.name).toBe('openai-compat');
  });

  it('has a distinct name from plain OpenAI so a rate limit never fails over to a paid key', () => {
    // otherProvider() in agent/loop.ts swaps openai<->anthropic by exact name
    // match. If a compat provider kept the literal name 'openai', a 429
    // against a free/local endpoint (which routinely rate-limits) would
    // silently redirect to a real, paid Anthropic key sitting in the same
    // environment — a run the user deliberately pointed elsewhere must never
    // fail over to someone else's paid API.
    const compat = new OpenAIProvider('llama3', { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' }, { GROQ_API_KEY: 'x' });
    const plain = new OpenAIProvider('gpt-5', undefined, { OPENAI_API_KEY: 'sk-x' });
    expect(compat.name).not.toBe(plain.name);
    expect(['openai', 'anthropic']).not.toContain(compat.name);
  });

  it('throws naming the configured env var when the key is missing for a remote endpoint', () => {
    expect(
      () => new OpenAIProvider('llama-3.3-70b-versatile', { baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY' }, {}),
    ).toThrow('GROQ_API_KEY is not set');
  });

  it('a local/loopback endpoint constructs with no key at all (Ollama)', () => {
    expect(
      () => new OpenAIProvider('llama3', { baseURL: 'http://localhost:11434/v1', apiKeyEnv: 'UNUSED' }, {}),
    ).not.toThrow();
  });

  it('throws when there is no baseURL and no key (plain OpenAI, unchanged)', () => {
    expect(() => new OpenAIProvider('gpt-5', undefined, {})).toThrow('OPENAI_API_KEY is not set');
  });

  it('defaults cleanly with only an env-injected key, no options', () => {
    expect(() => new OpenAIProvider('gpt-5', undefined, { OPENAI_API_KEY: 'sk-test' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Real loopback HTTP server tests — the request actually lands on the
// configured endpoint with the right header/model, not just a constructed
// object. A passing mock-only test would not catch a bug in how baseURL or
// the key reaches the wire; this crosses that seam for real.
// ---------------------------------------------------------------------------
describe('OpenAIProvider — request actually reaches the configured endpoint', () => {
  it('sends the model id and Bearer key from the configured env var to the configured baseURL', async () => {
    const seen: { url?: string; auth?: string; body?: Record<string, unknown> } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.body = JSON.parse(raw) as Record<string, unknown>;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: 'pong', tool_calls: [] } }],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const p = new OpenAIProvider('qwen-3-coder', { baseURL: `http://127.0.0.1:${port}/v1`, apiKeyEnv: 'GROQ_API_KEY' }, { GROQ_API_KEY: 'gsk-test' });
      const turn = await p.chat([{ role: 'user', content: 'ping' }], []);
      expect(seen.url).toBe('/v1/chat/completions');
      expect(seen.auth).toBe('Bearer gsk-test');
      expect(seen.body?.model).toBe('qwen-3-coder');
      expect(turn.text).toBe('pong');
      expect(turn.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('a keyless loopback endpoint still sends a request the server accepts (Ollama shape)', async () => {
    let hit = false;
    const server = createServer((req, res) => {
      hit = true;
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: {} }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      const p = new OpenAIProvider('llama3', { baseURL: `http://localhost:${port}/v1`, apiKeyEnv: 'UNUSED' }, {});
      const turn = await p.chat([{ role: 'user', content: 'hi' }], []);
      expect(hit).toBe(true);
      expect(turn.text).toBe('ok');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('config.json openaiCompatBaseUrl reaches a real do run (no injected provider)', () => {
  // Every other test here injects the provider or constructs OpenAIProvider
  // directly. Nothing else proves a `compat:` model configured through
  // .copperhead/config.json actually reaches the request on a real `do` run —
  // this crosses that seam with a loopback server standing in for a compat
  // endpoint.
  it('a compat baseURL configured in .copperhead/config.json is honoured end-to-end', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    const seen: { url?: string; auth?: string; model?: unknown } = {};
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.url = req.url;
        seen.auth = req.headers.authorization;
        seen.model = (JSON.parse(raw) as { model?: unknown }).model;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [
                    {
                      id: 'fin',
                      type: 'function',
                      function: { name: 'finish', arguments: JSON.stringify({ outcome: 'refuse', summary: 'nothing to do (test)' }) },
                    },
                  ],
                },
              },
            ],
            usage: { prompt_tokens: 11, completion_tokens: 4 },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    try {
      await mkdir(path.join(repo, '.copperhead'), { recursive: true });
      await writeFile(
        path.join(repo, '.copperhead', 'config.json'),
        JSON.stringify({ openaiCompatBaseUrl: `http://127.0.0.1:${port}/v1`, openaiCompatApiKeyEnv: 'COMPAT_TEST_KEY' }),
        'utf8',
      );
      await execa('git', ['add', '-A'], { cwd: repo });
      await execa('git', ['commit', '-q', '-m', 'compat config'], { cwd: repo });

      process.env.COMPAT_TEST_KEY = 'compat-test-key-value';
      let res;
      try {
        res = await runAgentLoop({
          repoRoot: repo,
          request: 'compat baseURL threading test',
          model: 'compat:qwen-3-coder',
          log: () => {},
        });
      } finally {
        delete process.env.COMPAT_TEST_KEY;
      }

      expect(seen.url).toBe('/v1/chat/completions');
      expect(seen.auth).toBe('Bearer compat-test-key-value');
      expect(seen.model).toBe('qwen-3-coder');
      expect(res.outcome).toBe('refused');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// makeProvider — explicit compat:<model-id> routing
// ---------------------------------------------------------------------------
describe('makeProvider — compat: routing', () => {
  const groq = { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' };
  const withKey = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env.GROQ_API_KEY = 'gsk-test';
    try {
      return await fn();
    } finally {
      delete process.env.GROQ_API_KEY;
    }
  };

  it('routes compat:<model-id> to OpenAIProvider with the openai-compat name', async () => {
    await withKey(async () => {
      const p = await makeProvider('compat:qwen-3-coder', false, groq);
      expect(p).toBeInstanceOf(OpenAIProvider);
      expect(p.name).toBe('openai-compat');
    });
  });

  it('a plain model id is never redirected by a configured compat endpoint (opt-in only)', async () => {
    // Regression guard for the exact footgun the old catch-all design had: a
    // stray openaiCompatBaseUrl must never hijack an unrelated gpt-5/claude run.
    process.env.OPENAI_API_KEY = 'sk-test';
    try {
      const p = await makeProvider('gpt-5', false, groq);
      expect(p.name).toBe('openai');
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it('rejects an empty override, like every other prefixed route', async () => {
    await expect(makeProvider('compat:', false, groq)).rejects.toThrow('compat model override cannot be empty');
  });

  it('refuses bare `compat` with no endpoint configured', async () => {
    await expect(makeProvider('compat', false, { openaiCompatApiKeyEnv: DEFAULT_OPENAI_COMPAT_API_KEY_ENV })).rejects.toThrow(
      /requires a model id and an endpoint/,
    );
  });

  it('refuses bare `compat` even when an endpoint IS configured — no silent default model', async () => {
    // Bug class this guards against: falling through here would build
    // `new OpenAIProvider(undefined, ...)`, which defaults to the literal
    // model id "gpt-5" — sent to whatever host openaiCompatBaseUrl points at.
    // Unlike gpt-5/claude, a compat endpoint has no id that is ever correct to
    // assume, so this must throw regardless of whether the endpoint is set.
    await withKey(async () => {
      await expect(makeProvider('compat', false, groq)).rejects.toThrow(/requires a model id/);
    });
  });

  it('refuses compat:<model-id> with no endpoint configured — no silent fallback to real OpenAI', async () => {
    // Bug class this guards against: a model id alone with no baseURL guard
    // would build OpenAIProvider with no baseURL, silently hitting real
    // api.openai.com with a non-OpenAI model id.
    await withKey(async () => {
      await expect(makeProvider('compat:llama-3.1-8b-instant', false, { openaiCompatApiKeyEnv: 'GROQ_API_KEY' })).rejects.toThrow(
        /requires an endpoint/,
      );
    });
  });

  it('surfaces the missing key for a remote endpoint', async () => {
    await expect(makeProvider('compat:qwen-3-coder', false, groq)).rejects.toThrow('GROQ_API_KEY is not set');
  });

  it('falls back to the default key env when compat settings are omitted entirely', async () => {
    await expect(makeProvider('compat:qwen-3-coder')).rejects.toThrow(/requires an endpoint/);
  });
});

// ---------------------------------------------------------------------------
// checkCredential — compat-aware, with URL-credential redaction
// ---------------------------------------------------------------------------
describe('checkCredential — compat endpoint', () => {
  const groq = { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' };

  it('reports the configured key env-var name and endpoint when the key is set', () => {
    const check = checkCredential('compat:llama-3.3-70b-versatile', { GROQ_API_KEY: 'gsk_test' }, groq);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('GROQ_API_KEY');
    expect(check.detail).toContain('api.groq.com');
  });

  it('fails with a hint pointing to the custom env-var when the key is missing', () => {
    const check = checkCredential('compat:llama-3.3-70b-versatile', {}, groq);
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('GROQ_API_KEY');
    expect(check.hint).toContain('GROQ_API_KEY');
  });

  it('a bare OPENAI_API_KEY lying around must not satisfy a Groq endpoint', () => {
    const check = checkCredential('compat:llama-3.3-70b-versatile', { OPENAI_API_KEY: 'sk-x' }, groq);
    expect(check.status).toBe('fail');
    expect(check.hint).toContain('GROQ_API_KEY');
  });

  it('env vars override config fields (COPPERHEAD_API_KEY_ENV > openaiCompatApiKeyEnv)', () => {
    // resolveCompatSettings is what applies this precedence; checkCredential
    // just receives the already-resolved settings, exactly as production does.
    const settings = resolveCompatSettings(
      { ...base, openaiCompatBaseUrl: 'https://api.cerebras.ai/v1', openaiCompatApiKeyEnv: 'CEREBRAS_API_KEY' },
      { COPPERHEAD_API_KEY_ENV: 'GROQ_API_KEY' },
    );
    const check = checkCredential('compat:llama-3.3-70b-versatile', { GROQ_API_KEY: 'gsk_test' }, settings);
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('GROQ_API_KEY');
    expect(check.detail).not.toContain('CEREBRAS_API_KEY');
  });

  it('a local endpoint passes with no key required', () => {
    const check = checkCredential('compat:llama3', {}, { openaiCompatBaseUrl: 'http://localhost:11434/v1', openaiCompatApiKeyEnv: 'UNUSED' });
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('no key required');
  });

  it('compat with no endpoint configured fails with an actionable hint', () => {
    const check = checkCredential('compat:x', {}, { openaiCompatApiKeyEnv: 'OPENAI_API_KEY' });
    expect(check.status).toBe('fail');
    expect(check.hint).toContain('COPPERHEAD_BASE_URL');
  });

  it('rejects an empty compat override, matching makeProvider', () => {
    expect(checkCredential('compat:', {}, groq).status).toBe('fail');
  });

  it('rejects bare `compat` even with a valid endpoint and key present (would otherwise be a false [ok])', () => {
    const c = checkCredential('compat', { GROQ_API_KEY: 'gsk-x' }, groq);
    expect(c.status).toBe('fail');
    expect(c.detail).toContain('missing model id');
  });

  it('strips a credential embedded in the endpoint URL from the displayed report', () => {
    const leaky = { openaiCompatBaseUrl: 'https://api.example.com/v1?key=sk-shouldnotleak123', openaiCompatApiKeyEnv: 'X_API_KEY' };
    const c = checkCredential('compat:model', { X_API_KEY: 'x' }, leaky);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('sk-shouldnotleak123');
    expect(c.detail).toContain('api.example.com');
  });

  it('strips a Gemini-shaped key (AIza..., not sk-...) from the endpoint URL', () => {
    // redactSecrets' key-shape patterns (sk-, Bearer, npm_, gh*_) don't match
    // Gemini's AIza... format, and Gemini's compat endpoint puts the key in
    // the URL as ?key=.... Dropping the whole query string (not pattern-
    // matching the key) is what makes this hold for any provider's key shape.
    const gemini = {
      openaiCompatBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai?key=AIzaSyABCDEF1234567890shouldnotleak',
      openaiCompatApiKeyEnv: 'GEMINI_API_KEY',
    };
    const c = checkCredential('compat:gemini-2.5-flash', { GEMINI_API_KEY: 'x' }, gemini);
    expect(c.status).toBe('ok');
    expect(c.detail).not.toContain('AIzaSyABCDEF1234567890shouldnotleak');
    expect(c.detail).not.toContain('key=');
    expect(c.detail).toContain('generativelanguage.googleapis.com');
  });
});

describe('checkCredential — non-compat models unchanged', () => {
  it('defaults to OPENAI_API_KEY for a plain model id', () => {
    const check = checkCredential('gpt-5', { OPENAI_API_KEY: 'sk-test' });
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('OPENAI_API_KEY');
  });

  it('a configured compat endpoint never leaks into a plain model’s check', () => {
    const groq = { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' };
    const check = checkCredential('gpt-5', { GROQ_API_KEY: 'gsk_test' }, groq);
    expect(check.status).toBe('fail'); // OPENAI_API_KEY, not GROQ_API_KEY, is what a plain gpt-5 needs
    expect(check.detail).toContain('OPENAI_API_KEY');
  });
});

// ---------------------------------------------------------------------------
// checkPromptPrivacy — doctor's preflight wrapper around classifyPromptPrivacy
// ---------------------------------------------------------------------------
describe('checkPromptPrivacy', () => {
  it('warns (never fails) on a documented training-risk host', () => {
    const warn = checkPromptPrivacy('compat:gemini-2.0-flash', {
      openaiCompatBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      openaiCompatApiKeyEnv: 'GEMINI_API_KEY',
    });
    expect(warn?.status).toBe('warn');
    expect(warn?.detail).toMatch(/train/i);
  });

  it('reports info (not warn) when no policy is on record', () => {
    const c = checkPromptPrivacy('compat:qwen', { openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' });
    expect(c?.status).toBe('info');
    expect(c?.detail).toMatch(/cannot verify/i);
  });

  it('returns null for non-compat models', () => {
    expect(checkPromptPrivacy('gpt-5')).toBeNull();
    expect(checkPromptPrivacy('claude')).toBeNull();
  });

  it('a training-risk warning still leaves the overall report ready (exit 0)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'compat:gemini-2.0-flash',
        deps: {
          nodeVersion: process.version,
          kicadVersion: async () => '9.0.0',
          gitVersion: async () => '2.40.0',
          env: {
            GEMINI_API_KEY: 'x',
            COPPERHEAD_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta/openai',
            COPPERHEAD_API_KEY_ENV: 'GEMINI_API_KEY',
          },
        },
      });
      expect(r.checks.find((c) => c.name === 'privacy')?.status).toBe('warn');
      expect(r.ok).toBe(true); // warn never blocks
    } finally {
      await cleanup();
    }
  });

  it('doctor stays fully network-free even for a compat model (no "endpoint" check exists)', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const r = await runDoctor({
        repoRoot: repo,
        model: 'compat:qwen',
        deps: {
          nodeVersion: process.version,
          kicadVersion: async () => '9.0.0',
          gitVersion: async () => '2.40.0',
          env: { GROQ_API_KEY: 'gsk-x', COPPERHEAD_BASE_URL: 'https://api.groq.com/openai/v1', COPPERHEAD_API_KEY_ENV: 'GROQ_API_KEY' },
        },
      });
      expect(r.checks.find((c) => c.name === 'endpoint')).toBeUndefined();
      expect(r.ok).toBe(true);
    } finally {
      await cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig — round-trips the two config fields
// ---------------------------------------------------------------------------
describe('loadConfig round-trips openaiCompat fields', () => {
  it('returns both fields when present in config.json', async () => {
    const { repo, cleanup } = await tempFixtureRepo();
    try {
      const configDir = path.join(repo, '.copperhead');
      await mkdir(configDir, { recursive: true });
      await writeFile(
        path.join(configDir, 'config.json'),
        JSON.stringify({ openaiCompatBaseUrl: 'https://api.groq.com/openai/v1', openaiCompatApiKeyEnv: 'GROQ_API_KEY' }),
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
