# Tasks: add-mcp-server

## 1. Command-layer refactor

- [ ] 1.1 Export callable entry points from `check`, `do`, `sync`, and `init` commands returning the structured objects `--json` prints (typed results, typed errors); CLI paths call the same functions
- [ ] 1.2 Assert CLI output is byte-identical before and after the refactor (golden tests on `--json` output)

## 2. Server

- [ ] 2.1 Add `@modelcontextprotocol/sdk`; implement `src/mcp/server.ts` with stdio transport and the four tool registrations with JSON schemas
- [ ] 2.2 Implement `copperhead_check` (fab/strict inputs) and `copperhead_init` dispatch
- [ ] 2.3 Implement `copperhead_do`: AUTO marker, optional `dry_run`, progress notifications during the run, summary result (`committed`/`rolled_back`/`refused`, commit hash, files touched, verification, transcript path)
- [ ] 2.4 Implement `copperhead_sync` with `resolve` gating
- [ ] 2.5 Implement key detection: typed missing-key errors for LLM tools, keyless operation for check/init; assert keys never appear in results
- [ ] 2.6 Implement per-repo serialization of mutating tools with typed busy error; concurrent check allowed
- [ ] 2.7 Wire `copperhead mcp [--repo]` into the CLI with the bad-path error

## 3. Tests

- [ ] 3.1 Protocol tests over stdio with golden request/response fixtures (tool list, each tool, progress notifications), pinned protocol version
- [ ] 3.2 Parity test: `copperhead_check` result equals `check --json` on the same repo state
- [ ] 3.3 Rollback-as-result test; keyless degradation tests; serialization/busy test
- [ ] 3.4 Surface audit test: enumerate registered tools, assert none can mutate files outside the gated pipeline

## 4. Integrations and distribution

- [ ] 4.1 Write the companion Claude Code skill under `integrations/claude-code/` (use copperhead tools, never edit `.kicad_*` directly); Codex equivalent or a documented gap note
- [ ] 4.2 README: MCP section with host configuration snippets (Claude Code, generic stdio host)
- [ ] 4.3 Submit registry listings (modelcontextprotocol servers repo, community registries); track links in integrations/README
