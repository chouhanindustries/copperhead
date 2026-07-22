# Integrations

Host integrations for the copperhead MCP server (`copperhead mcp`). The server exposes the gated pipeline to any MCP host as four opaque tools (`copperhead_check`, `copperhead_do`, `copperhead_sync`, `copperhead_init`), so an agent host can run the whole gated loop without being able to reach around spec-gating or verification. See the main [README](../README.md#mcp-server) for what the server is and does.

## Configure the server in an MCP host

The server runs over stdio. Point your host at the installed `copperhead` binary with the `mcp` subcommand and a `--repo` path.

### Claude Code

Add an entry to your MCP config (project `.mcp.json`, or the Claude Code settings):

```json
{
  "mcpServers": {
    "copperhead": {
      "command": "copperhead",
      "args": ["mcp", "--repo", "/absolute/path/to/your/kicad-repo"]
    }
  }
}
```

If `copperhead` is not on the host's `PATH`, use an absolute path to the binary (or `node /absolute/path/to/dist/cli.js`) as `command`.

### Generic stdio host

Any MCP host that spawns a stdio server can run:

```bash
copperhead mcp --repo /absolute/path/to/your/kicad-repo
```

The process serves the MCP protocol on stdout and logs to stderr. It runs until the host closes the transport.

## Companion skill

[`claude-code/copperhead/`](claude-code/copperhead/) is a Claude Code skill that tells the host agent to use the `copperhead_*` tools instead of editing `.kicad_*` files directly. Install it by copying the `copperhead` skill directory into your skills location:

```bash
# project-local
cp -r integrations/claude-code/copperhead .claude/skills/
# or user-global
cp -r integrations/claude-code/copperhead ~/.claude/skills/
```

### Codex and other hosts

The skill format above is Claude Code's. Codex does not consume the same skill package today; for Codex, add the equivalent instruction ("use the copperhead MCP tools; never edit `.kicad_*` directly") to the project's `AGENTS.md`. This gap will close when a shared skill format is available.

## Registry listings

Public MCP registry submissions (the modelcontextprotocol servers repo and community registries) are tracked here once published:

- (none yet)
