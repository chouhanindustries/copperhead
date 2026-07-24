# cli-surface — Delta Spec

## ADDED Requirements

### Requirement: `cursor` model selection values

`--model`, `COPPERHEAD_MODEL`, and `.copperhead/config.json` `model` SHALL accept `cursor` and `cursor:<model-id>`, routed to the `cursor` provider in `makeProvider()`.

#### Scenario: cursor routes to saved-login provider
- **WHEN** `--model cursor` is resolved
- **THEN** the run uses the `cursor` provider and does not require OpenAI/Anthropic API keys
