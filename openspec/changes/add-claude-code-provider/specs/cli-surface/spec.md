# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `claude-code` model selection values
`--model`, the `COPPERHEAD_MODEL` env var, and the `model` field in `.copperhead/config.json` SHALL accept `claude-code` (the Claude Code saved-login provider on its default model) and `claude-code:<model-id>` (the same provider on a specific model id). These values SHALL route to the `claude-code` provider and SHALL be matched **before** the `claude*` prefix that routes to the Anthropic API provider, so `claude-code` is never captured by the Anthropic route. The existing values (`claude`, `claude-<id>`, `gpt-5`, and any other string to OpenAI) SHALL keep their current routing.

#### Scenario: claude-code routes to the saved-login provider
- **WHEN** `--model claude-code` (or `--model claude-code:opus`) is resolved
- **THEN** the run uses the `claude-code` provider (on its default model, or the given id) and does not require `ANTHROPIC_API_KEY`

#### Scenario: Anthropic API routing is unaffected
- **WHEN** `--model claude` or `--model claude-sonnet-5` is resolved
- **THEN** the run uses the Anthropic API provider exactly as before, keyed by `ANTHROPIC_API_KEY`
