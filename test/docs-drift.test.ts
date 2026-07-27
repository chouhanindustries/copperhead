import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

describe('agent install prompt drift check', () => {
  it('ensures agent-install-prompt.md and mirrored docs page match exactly', async () => {
    const rootPath = path.resolve(__dirname, '../agent-install-prompt.md');
    const docsPath = path.resolve(__dirname, '../docs/src/content/docs/getting-started/agent-install.md');

    const rootContent = await readFile(rootPath, 'utf8');
    const docsContentRaw = await readFile(docsPath, 'utf8');

    // Strip Jekyll/Astro frontmatter from the docs file:
    // Frontmatter is enclosed between the first and second occurrences of '---' at the top.
    const frontmatterRegex = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
    const docsContent = docsContentRaw.replace(frontmatterRegex, '');

    // Standardize newlines and strip leading/trailing newlines to prevent cross-platform CRLF vs LF failures
    const normalize = (str: string) => str.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\n+$/, '');

    expect(normalize(docsContent)).toBe(normalize(rootContent));
  });
});
