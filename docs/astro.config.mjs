import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';

const REPO = 'https://github.com/chouhanindustries/copperhead';

// Served at the root of its own subdomain, docs.copperhead.sh. The apex,
// copperhead.sh, is a separate Cloudflare Worker (the copperhead-site repo),
// so Pages cannot own a path under it.
export default defineConfig({
  site: 'https://docs.copperhead.sh',
  integrations: [
    starlight({
      title: 'copperhead',
      description:
        'Cursor for circuit boards: an AI agent that designs, documents, and validates real PCBs on KiCad repositories',
      social: [{ icon: 'github', label: 'GitHub', href: REPO }],
      editLink: { baseUrl: `${REPO}/edit/main/docs/` },
      lastUpdated: true,
      customCss: ['./src/styles/custom.css'],
      head: [
        { tag: 'meta', attrs: { name: 'theme-color', content: '#b87333' } },
      ],
      sidebar: [
        {
          label: 'Getting started',
          items: [
            { label: 'Introduction', link: '/getting-started/introduction/' },
            { label: 'Quickstart', link: '/getting-started/quickstart/' },
            { label: 'Simple demo', link: '/getting-started/demo/' },
          ],
        },
        {
          label: 'Concepts',
          items: [
            { label: 'The agent loop', link: '/concepts/agent-loop/' },
            { label: 'Guardrails', link: '/concepts/guardrails/' },
            { label: 'Docs as memory', link: '/concepts/docs-as-memory/' },
          ],
        },
        {
          label: 'Workflows',
          items: [
            { label: 'Design from a brief', link: '/workflows/create-from-brief/' },
            { label: 'Edit an existing board', link: '/workflows/edit-existing-board/' },
            { label: 'Verify and sync', link: '/workflows/verify-and-sync/' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'CLI', link: '/reference/cli/' },
            { label: 'Configuration', link: '/reference/configuration/' },
          ],
        },
        {
          label: 'Technical spec',
          link: `${REPO}/blob/main/openspec/specs/SPEC.md`,
          attrs: { target: '_blank' },
        },
      ],
    }),
  ],
});
