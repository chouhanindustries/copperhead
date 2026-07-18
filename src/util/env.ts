/**
 * Minimal .env loader.
 *
 * Keys are env-var-only by contract (AC-4.1), and they still are: this reads a
 * gitignored .env into process.env at startup and nothing else ever persists
 * them. No dependency, because dotenv's extra features (interpolation, multi-
 * file precedence) are all things we would have to reason about at key-handling
 * time.
 *
 * The real environment always wins. A .env file is a convenience for local runs,
 * so it must never quietly override what CI or a shell export already set.
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/** KEY=value, optional `export ` prefix, optional matched quotes. */
const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1]!;
    let value = m[2]!.trim();
    const quoted =
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1);
    if (quoted) {
      value = value.slice(1, -1);
    } else {
      // Only strip trailing comments from unquoted values; a `#` inside quotes
      // is part of the secret.
      const hash = value.indexOf(' #');
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/**
 * Load `<dir>/.env` into process.env without overriding existing values.
 * Returns the names (never the values) of the variables it set, for logging.
 */
export function loadEnvFile(dir: string): string[] {
  const p = path.join(dir, '.env');
  if (!existsSync(p)) return [];
  let parsed: Record<string, string>;
  try {
    parsed = parseEnv(readFileSync(p, 'utf8'));
  } catch {
    return [];
  }
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) {
      process.env[key] = value;
      applied.push(key);
    }
  }
  return applied;
}
