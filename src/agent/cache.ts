import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Provider, Msg, ToolSchema, ChatOpts, Turn } from './types.js';

export class CachingProvider implements Provider {
  readonly name: string;

  constructor(private inner: Provider, private cacheDir: string = '.copperhead/llm-cache') {
    this.name = `cached-${inner.name}`;
  }

  private hashRequest(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): string {
    const data = JSON.stringify({ messages, tools, opts });
    return createHash('sha256').update(data).digest('hex');
  }

  async chat(messages: Msg[], tools: ToolSchema[], opts?: ChatOpts): Promise<Turn> {
    const hash = this.hashRequest(messages, tools, opts);
    const filePath = path.join(this.cacheDir, `${hash}.json`);

    if (existsSync(filePath)) {
      const content = await readFile(filePath, 'utf8');
      return JSON.parse(content) as Turn;
    }

    if (process.env.COPPERHEAD_CACHE_ONLY === '1') {
      throw new Error(`Cache miss in COPPERHEAD_CACHE_ONLY mode for prompt hash: ${hash}`);
    }

    const turn = await this.inner.chat(messages, tools, opts);
    await mkdir(this.cacheDir, { recursive: true });
    await writeFile(filePath, JSON.stringify(turn, null, 2), 'utf8');
    return turn;
  }
}
